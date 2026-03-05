
import { logger } from './src/utils/logger';

// Mock AgentOptions
interface AgentOptions {
  onProgress?: (message: string) => void;
}

// Simulated JSON stream chunks from Claude CLI
const simulatedChunks = [
  '{"type":"message_start","message":{"id":"msg_123","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}} }\n',
  '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""} }\n',
  '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I need"} }\n',
  '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" to check"} }\n',
  '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the files."} }\n',
  '{"type":"content_block_stop","index":0 }\n',
  '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""} }\n',
  '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"} }\n',
  '{"type":"content_block_stop","index":1 }\n',
  '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":15} }\n',
  '{"type":"message_stop"}\n'
];

async function testStreamParser() {
  console.log('Starting stream parser test...');
  
  const onProgress = (msg: string) => {
    console.log(`[Progress Callback] ${msg}`);
  };

  let buffer = '';
  
  // Simulate processing chunks
  for (const chunk of simulatedChunks) {
    const text = chunk;
    buffer += text;
    
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const json = JSON.parse(line);
        // console.log('Parsed JSON type:', json.type);

        // Logic from src/agent/index.ts
        if (onProgress) {
             // Case A: message_delta with thinking (from my previous fix attempt? No, checking current code)
             // The current code has:
             /*
              if (json.type === 'message_delta' && json.delta?.thinking) { ... }
             */
             
             // Case B: content_block_delta with thinking_delta (This is what Claude usually sends!)
             if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta') {
                 const thought = json.delta.thinking;
                 onProgress(`🤔 ${thought}`);
             }

             // Case C: The current code logic for 'assistant' message (Block-based)
             /*
              if (json.type === 'assistant' && json.message?.content) { ... }
             */
             // This logic expects the FULL message structure, which usually comes at the start or end, 
             // NOT in the streaming deltas.
        }
        
      } catch (e) {
        console.error('JSON parse error:', e);
      }
    }
  }
}

testStreamParser();
