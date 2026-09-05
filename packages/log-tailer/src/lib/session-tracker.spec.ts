import { describe, expect, it } from 'vitest';
import { parseChatLine } from './chat-parser.js';
import { SessionTracker, sessionDurationMs } from './session-tracker.js';
import { parseSessionEventLine } from './session-event-parser.js';
import type { ChatEvent, SessionEvent } from './types.js';

function connectEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return parseSessionEventLine(`0:00 J;${overrides.guid ?? '0'};${overrides.num ?? 0};${overrides.name ?? 'Player'}`)!;
}

function quitEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return parseSessionEventLine(`0:00 Q;${overrides.guid ?? '0'};${overrides.num ?? 0};${overrides.name ?? 'Player'}`)!;
}

function chatEvent(overrides: Partial<{ num: number; name: string; message: string }> = {}): ChatEvent {
  return parseChatLine(`0:00 say;0;${overrides.num ?? 0};${overrides.name ?? 'Player'};${overrides.message ?? 'hi'}`)!;
}

describe('SessionTracker', () => {
  it('creates a session on connect and reports duration from a wall-clock, not the in-game timestamp', () => {
    let clock = 1_000;
    const tracker = new SessionTracker({ now: () => clock });

    tracker.handleSessionEvent(connectEvent({ num: 3, name: 'Alice' }));
    clock = 5_000;

    const session = tracker.getSession(3)!;
    expect(session).toMatchObject({ num: 3, guid: '0', name: 'Alice' });
    expect(session.disconnectedAt).toBeUndefined();
    expect(sessionDurationMs(session, clock)).toBe(4_000);
  });

  it('keeps the session (marked disconnected) instead of deleting it on quit', () => {
    let clock = 1_000;
    const tracker = new SessionTracker({ now: () => clock });

    tracker.handleSessionEvent(connectEvent({ num: 3, name: 'Alice' }));
    clock = 4_000;
    tracker.handleSessionEvent(quitEvent({ num: 3, name: 'Alice' }));

    const session = tracker.getSession(3)!;
    expect(session.disconnectedAt).toBe(4_000);
    expect(sessionDurationMs(session, 9_000)).toBe(3_000); // frozen at disconnect, not still ticking
    expect(tracker.listSessions()).toEqual([session]);
  });

  it('starts a fresh session (dropping old chat history) when a slot reconnects', () => {
    const tracker = new SessionTracker({ now: () => 0 });

    tracker.handleSessionEvent(connectEvent({ num: 0, name: 'Alice' }));
    tracker.handleChat(chatEvent({ num: 0, name: 'Alice', message: 'first session' }));
    tracker.handleSessionEvent(quitEvent({ num: 0, name: 'Alice' }));

    tracker.handleSessionEvent(connectEvent({ num: 0, name: 'Bob' }));

    const session = tracker.getSession(0)!;
    expect(session.name).toBe('Bob');
    expect(session.disconnectedAt).toBeUndefined();
    expect(session.chatHistory).toEqual([]);
  });

  it('backfills name from chat once it propagates, without clobbering it with a later empty name', () => {
    const tracker = new SessionTracker({ now: () => 0 });
    tracker.handleSessionEvent(connectEvent({ num: 0, name: '' }));

    tracker.handleChat(chatEvent({ num: 0, name: '', message: 'WHAT/???' }));
    expect(tracker.getSession(0)!.name).toBe('');

    tracker.handleChat(chatEvent({ num: 0, name: 'WOWOWOW', message: 'HEU!' }));
    expect(tracker.getSession(0)!.name).toBe('WOWOWOW');
  });

  it('caps the chat ring buffer at chatHistorySize, dropping the oldest first', () => {
    const tracker = new SessionTracker({ now: () => 0, chatHistorySize: 2 });
    tracker.handleSessionEvent(connectEvent({ num: 0 }));

    tracker.handleChat(chatEvent({ num: 0, message: 'one' }));
    tracker.handleChat(chatEvent({ num: 0, message: 'two' }));
    tracker.handleChat(chatEvent({ num: 0, message: 'three' }));

    expect(tracker.getSession(0)!.chatHistory.map((c) => c.message)).toEqual(['two', 'three']);
  });

  it('ignores chat for a slot with no live session (unknown or already disconnected)', () => {
    const tracker = new SessionTracker({ now: () => 0 });
    tracker.handleChat(chatEvent({ num: 7, message: 'ghost' }));
    expect(tracker.getSession(7)).toBeUndefined();

    tracker.handleSessionEvent(connectEvent({ num: 0 }));
    tracker.handleSessionEvent(quitEvent({ num: 0 }));
    tracker.handleChat(chatEvent({ num: 0, message: 'after quit' }));
    expect(tracker.getSession(0)!.chatHistory).toEqual([]);
  });

  it('synthesizes an already-disconnected session for a quit with no prior known connect', () => {
    const tracker = new SessionTracker({ now: () => 42 });
    const session = tracker.handleSessionEvent(quitEvent({ num: 5, name: 'MidStream' }));

    expect(session).toEqual({
      num: 5,
      guid: '0',
      name: 'MidStream',
      connectedAt: 42,
      disconnectedAt: 42,
      chatHistory: [],
    });
    expect(tracker.getSession(5)).toEqual(session);
  });
});
