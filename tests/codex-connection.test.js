import test from "node:test";
import assert from "node:assert/strict";
import { createCodexConnection } from "../web/src/lib/codex-connection.js";

function fixture() {
  const timers = new Map(), sockets = [], messages = [], failures = [];
  let time = 0, id = 0, generation = 0, opens = 0;
  const store = { state: { threadId: "thread", epoch: "epoch", seq: 7, connection: "offline" }, beginSocket: () => ++generation };
  const connection = createCodexConnection({ store, location: { protocol: "https:", host: "example.test" },
    isDisposed: () => false, now: () => time, errors: { begin: () => ({}), succeed() {}, fail: (_, error) => failures.push(error.message) },
    onOpen: () => { opens += 1; }, onMessage: (_, token) => messages.push(token),
    setTimer: (callback, delay) => { timers.set(++id, { callback, at: time + delay }); return id; },
    clearTimer: (key) => timers.delete(key),
    createSocket: (url) => {
      const socket = { url, closes: 0, readyState: 0, close() { this.closes += 1; },
        open() { this.readyState = 1; this.onopen(); } };
      sockets.push(socket); return socket;
    } });
  function advance(duration) {
    const end = time + duration;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [key, timer] = next; timers.delete(key); time = timer.at; timer.callback();
    }
    time = end;
  }
  return { connection, store, sockets, messages, failures, timers, advance, opens: () => opens };
}

test("a handshake that never opens or closes expires and reconnects with the saved event cursor", () => {
  const f = fixture();
  f.connection.connect();
  assert.equal(f.store.state.connection, "connecting");
  f.advance(29999); assert.equal(f.sockets.length, 1);
  f.advance(1);
  assert.equal(f.store.state.connection, "offline");
  assert.equal(f.sockets[0].closes, 1);
  assert.match(f.failures[0], /超时/);
  f.advance(2000); assert.equal(f.sockets.length, 2);
  assert.match(f.sockets[1].url, /epoch=epoch&after=7$/);
  f.sockets[1].open();
  assert.equal(f.store.state.connection, "connected");
  assert.equal(f.timers.size, 0);
  f.connection.dispose();
});

test("an error retries without waiting for close and duplicate stale lifecycle events cannot add retries", () => {
  const f = fixture(); f.connection.connect();
  const first = f.sockets[0]; first.open(); first.onerror();
  assert.equal(f.store.state.connection, "offline");
  assert.equal(f.timers.size, 1);
  first.onclose(); first.onerror();
  assert.equal(f.timers.size, 1);
  f.advance(2000); f.sockets[1].open();
  first.onopen(); first.onmessage({ data: "stale" });
  assert.equal(f.opens(), 2); assert.deepEqual(f.messages, []);
  f.sockets[1].onmessage({ data: "current" }); assert.deepEqual(f.messages, [2]);
  f.connection.dispose(); assert.equal(f.timers.size, 0);
});

test("foreground resume replaces stale connected sockets and immediately retries offline sockets", () => {
  const f = fixture();
  f.connection.resume({ fromHidden: true }); assert.equal(f.sockets.length, 0, "resume cannot initialize unopened views");
  f.connection.connect(); f.sockets[0].open();
  f.connection.resume(); assert.equal(f.sockets.length, 1, "ordinary visible events preserve a healthy socket");
  f.store.state.seq = 11;
  f.connection.resume({ fromHidden: true });
  assert.equal(f.sockets[0].closes, 1);
  assert.equal(f.sockets.length, 2);
  assert.match(f.sockets[1].url, /after=11$/);
  f.connection.resume({ fromHidden: true });
  assert.equal(f.sockets.length, 2, "repeated visibility changes preserve an in-flight handshake");
  f.sockets[1].open();
  f.connection.resume({ fromHidden: true });
  assert.equal(f.sockets.length, 2, "brief foreground changes cannot repeatedly reconnect a newly healthy socket");
  f.sockets[1].onerror(); f.connection.resume();
  assert.equal(f.sockets.length, 3);
  assert.equal(f.timers.size, 1, "the new handshake replaces the old reconnect timer");
  f.connection.dispose(); assert.equal(f.timers.size, 0);
  f.sockets[2].onopen(); f.sockets[2].onclose(); f.advance(60000);
  assert.equal(f.sockets.length, 3);
});

test("foreground resume replaces an old unfinished handshake once while retaining a new one", () => {
  const f = fixture(); f.connection.connect();
  f.advance(10000); f.connection.resume({ fromHidden: true });
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[0].closes, 1);
  f.connection.resume({ fromHidden: true });
  assert.equal(f.sockets.length, 2);
  f.advance(29999);
  assert.equal(f.store.state.connection, "connecting");
  f.advance(1);
  assert.equal(f.store.state.connection, "offline", "replacing a handshake resets only its own bounded deadline");
  f.connection.dispose(); assert.equal(f.timers.size, 0);
});
