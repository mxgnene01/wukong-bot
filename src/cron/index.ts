import cron from 'node-cron';
import { getDB } from '../db';
import { getQueue } from '../queue';
import { parseNaturalLanguageSchedule, isScheduleCommand } from './parser';
import type { ScheduledTask, ChatContext } from '../types';

const scheduledJobs = new Map<string, cron.ScheduledTask>();

export function startCronScheduler() {
  console.log('Starting cron scheduler...');

  // 先停止所有现有任务，防止重复调度
  stopAllTasks();

  const db = getDB();
  const tasks = db.getScheduledTasks(true);

  for (const task of tasks) {
    scheduleTask(task);
  }

  console.log(`Scheduled ${tasks.length} tasks`);
}

export function scheduleTask(task: ScheduledTask) {
  if (!cron.validate(task.cron)) {
    console.error('Invalid cron expression:', task.cron);
    return;
  }

  const existing = scheduledJobs.get(task.id);
  if (existing) {
    existing.stop();
  }

  const job = cron.schedule(task.cron, () => {
    triggerScheduledTask(task);
  });

  scheduledJobs.set(task.id, job);
  console.log('Scheduled task:', task.name, 'cron:', task.cron);
}

function triggerScheduledTask(task: ScheduledTask) {
  console.log('Triggering scheduled task:', task.name);

  const queue = getQueue();

  // 只调用 queue.enqueue，它内部已经会处理数据库持久化
  queue.enqueue('scheduled', task.context, task.content, task.id);
}

export function stopAllTasks() {
  for (const [id, job] of scheduledJobs) {
    job.stop();
    scheduledJobs.delete(id);
  }
}

export function refreshTask(taskId: string) {
  const db = getDB();
  const task = db.getScheduledTask(taskId);

  if (!task) {
    const existing = scheduledJobs.get(taskId);
    if (existing) {
      existing.stop();
      scheduledJobs.delete(taskId);
    }
    return;
  }

  if (task.enabled) {
    scheduleTask(task);
  } else {
    const existing = scheduledJobs.get(taskId);
    if (existing) {
      existing.stop();
      scheduledJobs.delete(taskId);
    }
  }
}

export function createAndScheduleTask(
  name: string,
  cronExpr: string,
  context: ChatContext,
  content: string
): ScheduledTask {
  const db = getDB();
  const task = db.createScheduledTask(name, cronExpr, context, content);
  scheduleTask(task);
  return task;
}

export async function handleScheduleCommand(input: string, context: ChatContext): Promise<boolean> {
  if (!isScheduleCommand(input)) {
    return false;
  }

  const parsed = await parseNaturalLanguageSchedule(input);
  if (!parsed) {
    return false;
  }

  const db = getDB();
  createAndScheduleTask(
    `定时任务: ${parsed.description}`,
    parsed.cron,
    context,
    parsed.content
  );

  return true;
}
