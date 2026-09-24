import readline from 'node:readline';

const tools = [
  {
    name: 'add',
    description: '计算两个数字之和',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  {
    name: 'echo',
    description: '原样返回传入文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-mcp-server', version: '0.1.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'add') {
      const v = Number(args.a) + Number(args.b);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(v) }], isError: false } });
    } else if (name === 'echo') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(args.text ?? '') }], isError: false } });
    } else {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具 ${name}` }], isError: true } });
    }
  } else if (method === 'boom') {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: '故意失败' } });
  } else if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } });
  }
});
