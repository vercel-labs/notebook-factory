// @lat: [[chat#Reload state tests]]
// Reload persistence: editing mode and durable chat turns survive a refresh without getting stuck.
// Run after building the frontend; PLAYWRIGHT_MODULE may point to a local Playwright installation.
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const PORT = 5188;
const notebook = { id: 'one', title: 'Notebook one', owner_id: 1, revision: 1, updated_at: 1 };
const published = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'cell', cell_type: 'markdown', source: 'Published content', metadata: {} }] };
const log = { downloads: 0, starts: 0, closes: 0, stops: 0, states: 0, streams: 0, chats: [], puts: [] };
let history = { messages: [], revision: 0 };
let turn = { active: false };
let stream = null; // (res) => void for GET /chat/stream; null answers 204.
let chat = null; // (res, body) => void for POST /chat.

const sse = (res, events, end = true) => {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
  }
  res.write(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
  if (end) res.end('data: [DONE]\n\n');
};
const marker = data => ({ type: 'data-turn', data, transient: true });
const text = (id, delta) => [{ type: 'text-start', id }, { type: 'text-delta', id, delta }, { type: 'text-end', id }];
const reply = (messageId, delta) => [{ type: 'start', messageId }, { type: 'start-step' }, ...text('t-' + messageId, delta), { type: 'finish-step' }, { type: 'finish' }, marker({ state: 'done' })];

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  res.setHeader('Content-Type', 'application/json');
  const p = u.pathname;
  if (p === '/api/workspace') return res.end(JSON.stringify({ users: [{ id: 1, login: 'owner' }], notebooks: [notebook] }));
  if (p === '/api/auth/me') return res.end(JSON.stringify({ can_edit: true, configured: true, user: { login: 'owner', user_id: 1 } }));
  if (p.endsWith('/chat-history')) {
    if (req.method === 'PUT') { log.puts.push(body.messages); history = { messages: body.messages, revision: body.revision + 1 }; return res.end(JSON.stringify({ revision: history.revision })); }
    return res.end(JSON.stringify(history));
  }
  if (p.endsWith('/chat/state')) { log.states++; return res.end(JSON.stringify(turn)); }
  if (p.endsWith('/chat/stream')) { log.streams++; if (!stream) { res.statusCode = 204; return res.end(); } return stream(res); }
  if (p.endsWith('/chat/stop')) { log.stops++; turn = { active: false }; res.statusCode = 204; return res.end(); }
  if (p.endsWith('/chat')) { log.chats.push(body); return chat(res, body); }
  if (p.endsWith('/editor')) {
    log.starts++;
    res.setHeader('Content-Type', 'text/event-stream');
    return res.end('data: ' + JSON.stringify({ type: 'ready', editor: { name: 'test', token: 'token-' + log.starts, url: `http://127.0.0.1:${PORT}/editor-frame` } }) + '\n\n');
  }
  if (p.endsWith('/editor-status') || p.endsWith('/save')) return res.end('{}');
  if (p.endsWith('/close')) { log.closes++; return res.end('{}'); }
  if (p.endsWith('/download')) { log.downloads++; return res.end(JSON.stringify(published)); }
  if (p.endsWith('/render')) { res.setHeader('Content-Type', 'text/html'); return res.end('Published notebook'); }
  if (p === '/editor-frame') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<script>window.tools=[];addEventListener('message',e=>{const reply=result=>parent.postMessage({type:'vercel-notebook-tool-result',id:e.data.id,result},'*');if(e.data.type==='vercel-notebook-capabilities')reply({protocol:2,ready:true,connected:true});if(e.data.type==='vercel-notebook-tool'){window.tools.push(e.data.tool);reply({ok:true})}if(e.data.type==='vercel-notebook-export')parent.postMessage({type:'vercel-notebook-saved',id:e.data.id,source:'{}'},'*')})</script>Editor`);
  }
  if (p.startsWith('/api/')) { res.statusCode = 404; return res.end('{}'); }
  const file = path.join(process.cwd(), 'frontend/dist', p === '/' ? 'index.html' : p);
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  try { res.end(fs.readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
});

const until = async (check, message, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + message);
    await new Promise(r => setTimeout(r, 50));
  }
};
const user = (id, value) => ({ id, role: 'user', parts: [{ type: 'text', text: value }] });

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on('dialog', dialog => dialog.accept());
    const message = page.getByRole('textbox', { name: 'Message' });
    const open = async () => {
      await page.goto(`http://127.0.0.1:${PORT}/?notebook=one`);
      await page.getByRole('heading', { name: 'Notebook one', exact: true }).waitFor();
    };

    // A reload without a live turn checks the server, does not replay, and leaves chat usable.
    await open();
    await until(() => log.states === 1, 'turn state is checked once');
    await until(() => message.isEnabled(), 'composer is enabled when no turn is live');
    assert.equal(log.streams, 0, 'a stale or absent turn is not replayed');

    // Editing mode survives a reload, and quitting the editor clears it.
    await page.getByRole('button', { name: 'Edit notebook' }).click();
    await page.getByRole('button', { name: 'Quit editor' }).waitFor();
    assert.equal(log.starts, 1);
    await page.reload();
    await page.getByRole('button', { name: 'Quit editor' }).waitFor();
    assert.equal(log.starts, 2, 'reload reopens the editor this tab was using');
    await page.getByRole('button', { name: 'Quit editor' }).click();
    await page.getByRole('button', { name: 'Edit notebook' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Notebook one', exact: true }).waitFor();
    await until(() => message.isEnabled(), 'chat ready after reload');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(log.starts, 2, 'quitting the editor stops restoring editing mode');

    // The prompt of a running reply is checkpointed, so a reload does not lose it.
    let releaseChat;
    chat = (res) => {
      sse(res, [{ type: 'start', messageId: 'a-live' }, { type: 'start-step' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Working' }], false);
      releaseChat = () => sse(res, [{ type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' }, marker({ state: 'done' })]);
    };
    await message.fill('Plot something');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Working', { exact: true }).waitFor();
    await until(() => log.puts.some(messages => messages.length === 1 && messages[0].parts[0].text === 'Plot something'), 'user message saved while streaming');
    assert(!log.puts.some(messages => messages.some(m => m.id === 'a-live')), 'the in-flight assistant message is not checkpointed');
    releaseChat();
    await until(() => log.puts.some(messages => messages.some(m => m.id === 'a-live')), 'full turn saved after it ends');
    assert.equal(log.stops, 0, 'a finished turn does not need a stop request');

    // A reload during a parked turn reattaches, keeps streaming UI, and runs only parked calls:
    // safe reads repeat, a possibly executed cell run reports an interruption.
    history = { messages: [user('u1', 'Go')], revision: history.revision + 1 };
    turn = { active: true, phase: 'awaiting_tools', tool_call_ids: ['c2', 'c3'], editing: false };
    let releaseReplay;
    stream = (res) => {
      sse(res, [
        { type: 'start', messageId: 'a1' }, { type: 'start-step' }, ...text('t1', 'Let me read'),
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'read_notebook', input: {} },
        { type: 'tool-output-available', toolCallId: 'c1', output: { cells: [] } },
        { type: 'finish-step' }, { type: 'start-step' },
      ], false);
      releaseReplay = () => sse(res, [
        { type: 'tool-input-available', toolCallId: 'c2', toolName: 'read_notebook', input: {} },
        { type: 'tool-input-available', toolCallId: 'c3', toolName: 'run_cell', input: { cell_id: 'cell', expected_source: 'x' } },
        { type: 'finish-step' }, { type: 'finish' }, marker({ state: 'parked', toolCallIds: ['c2', 'c3'], editing: false }),
      ]);
    };
    chat = (res, body) => { turn = { active: false }; sse(res, reply('a1', 'Continued after reload')); };
    const chatsBefore = log.chats.length;
    await page.reload();
    await page.getByText('Let me read', { exact: true }).waitFor();
    assert(await message.isDisabled(), 'composer stays disabled while reattached');
    assert(await page.getByRole('button', { name: 'Stop reply' }).isVisible(), 'streaming controls survive the reload');
    releaseReplay();
    await page.getByText('Continued after reload', { exact: true }).waitFor();
    assert.equal(log.chats.length, chatsBefore + 1, 'one continuation resumes the parked turn');
    const continuation = log.chats.at(-1);
    const last = continuation.messages.at(-1);
    assert.equal(last.id, 'a1', 'continuation keeps the replayed assistant message');
    assert.equal(continuation.messages[0].parts[0].text, 'Go', 'checkpointed prompt precedes the reply');
    const outputs = Object.fromEntries(last.parts.filter(part => part.toolCallId).map(part => [part.toolCallId, part.output]));
    assert.deepEqual(outputs.c1, { cells: [] }, 'earlier rounds are not executed again');
    assert.equal(outputs.c2.version, 'published', 'safe parked read runs after reload');
    assert.match(outputs.c3.error, /Interrupted by a page reload/, 'unsafe parked call reports interruption');
    await until(() => message.isEnabled(), 'composer is enabled after the turn ends');
    assert.equal(log.stops, 0);

    // A dropped live stream reconnects to the still-running turn instead of stopping it.
    stream = (res) => { turn = { active: false }; sse(res, reply('a-drop', 'Recovered after drop')); };
    chat = (res) => {
      turn = { active: true, phase: 'model', tool_call_ids: [], editing: false };
      sse(res, [{ type: 'start', messageId: 'a-drop' }, { type: 'start-step' }, { type: 'text-start', id: 'd' }, { type: 'text-delta', id: 'd', delta: 'Partial' }], false);
      setTimeout(() => res.destroy(), 200);
    };
    const streamsBefore = log.streams;
    await message.fill('Keep going');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Recovered after drop', { exact: true }).waitFor();
    assert.equal(log.streams, streamsBefore + 1, 'one replay recovers the turn');
    await until(() => message.isEnabled(), 'recovered turn finishes');
    const recovered = log.puts.at(-1).find(m => m.id === 'a-drop');
    assert.deepEqual(recovered.parts.map(part => part.type), ['step-start', 'text'], 'the replay replaces partial output instead of appending');
    assert.equal(await page.getByText('Partial', { exact: true }).count(), 0);
    assert.equal(log.stops, 0, 'a dropped stream never stops the server turn');

    // A call this page already ran before the drop is not run again when the replay parks on it.
    const parkedRead = { type: 'tool-input-available', toolCallId: 'r1', toolName: 'read_notebook', input: {} };
    chat = (res, body) => {
      if (body.messages.at(-1).role === 'assistant') { turn = { active: false }; return sse(res, reply('a-r', 'Read once')); }
      turn = { active: true, phase: 'awaiting_tools', tool_call_ids: ['r1'], editing: false };
      sse(res, [{ type: 'start', messageId: 'a-r' }, { type: 'start-step' }, parkedRead], false);
      setTimeout(() => res.destroy(), 300);
    };
    stream = (res) => sse(res, [{ type: 'start', messageId: 'a-r' }, { type: 'start-step' }, parkedRead, { type: 'finish-step' }, { type: 'finish' }, marker({ state: 'parked', toolCallIds: ['r1'], editing: false })]);
    const downloadsBefore = log.downloads;
    await message.fill('Read it');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Read once', { exact: true }).waitFor();
    assert.equal(log.downloads, downloadsBefore + 1, 'the dispatched read ran exactly once');
    const resumed = log.chats.at(-1).messages.at(-1);
    assert.equal(resumed.parts.find(part => part.toolCallId === 'r1').output.version, 'published', 'its result still reaches the turn');

    // When the turn ends while the page is away, the server reports it stale and nothing spins.
    turn = { active: false };
    stream = null;
    history = { messages: [user('u9', 'Old'), { id: 'a9', role: 'assistant', parts: [{ type: 'text', text: 'Old answer', state: 'done' }] }], revision: history.revision + 1 };
    const statesBefore = log.states, streamsBeforeStale = log.streams;
    await page.reload();
    await page.getByText('Old answer', { exact: true }).waitFor();
    await until(() => message.isEnabled(), 'stale turn leaves composer usable');
    assert.equal(log.states, statesBefore + 1);
    assert.equal(log.streams, streamsBeforeStale, 'stale turn is not replayed');
    assert.equal(await page.getByText('Reconnecting to the assistant…').count(), 0);
    console.log('reload state checks passed');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  console.error('requests:', JSON.stringify({ ...log, chats: log.chats.length, puts: log.puts.length }));
  process.exit(1);
});
