# Custom JS Skills

Drop a `.skill.js` file here and it will be auto-loaded on engine start (or after `update.sh`).

## Template

```js
// skills/custom/my-skill.skill.js
module.exports = {
  id: 'my_skill',          // unique ID (no spaces)
  name: 'My Skill',        // human-readable name
  enabled: true,

  // Tool declarations — same schema as Gemini function declarations
  toolDeclarations: [
    {
      name: 'my_tool',
      description: 'Does something custom on the phone.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'What to do' }
        },
        required: ['query']
      }
    }
  ],

  // Called by the engine when the model invokes one of your tools
  // name   = tool name (useful if you declare multiple tools in one skill)
  // args   = object with the arguments the model passed
  // ctx    = engine context (see below)
  async handleTool(name, args, ctx) {
    switch (name) {
      case 'my_tool': {
        const output = await ctx.executeShell(`echo ${args.query}`);
        return { output };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
};
```

## Available `ctx` methods

| Method | Description |
|---|---|
| `ctx.executeShell(cmd)` | Run a shell command, returns stdout string |
| `ctx.appendLog(msg)` | Write a line to engine.log |
| `ctx.visitWebsite(url)` | Fetch a URL, returns raw HTML string |
| `ctx.searchWeb(query)` | Web search, returns summary string |
| `ctx.rememberRecord({ kind, key, value })` | Save to engine memory |
| `ctx.searchMemory(query, limit)` | Query engine memory |
| `ctx.delay(ms)` | `await ctx.delay(1000)` — sleep |

## Example: SMS sender via termux-telephony

```js
module.exports = {
  id: 'sms_sender',
  name: 'SMS Sender',
  enabled: true,
  toolDeclarations: [{
    name: 'send_sms',
    description: 'Send an SMS to a phone number.',
    parameters: {
      type: 'OBJECT',
      properties: {
        phone: { type: 'STRING', description: 'Phone number' },
        message: { type: 'STRING', description: 'SMS text' }
      },
      required: ['phone', 'message']
    }
  }],
  async handleTool(name, args, ctx) {
    // termux-telephony-sms-send is available when Termux:API is installed
    await ctx.executeShell(`termux-telephony-sms-send -n "${args.phone}" "${args.message}"`);
    return { sent: true, phone: args.phone };
  }
};
```
