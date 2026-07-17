import { describe, expect, it, mock } from "bun:test";
import { publishLibraryChanged, subscribeLibraryChanges } from "./events.bus";

describe("events bus", () => {
  it("notifies every subscriber on publish", () => {
    const first = mock(() => {});
    const second = mock(() => {});
    const unsubscribeFirst = subscribeLibraryChanges(first);
    const unsubscribeSecond = subscribeLibraryChanges(second);

    publishLibraryChanged();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("stops notifying after unsubscribe", () => {
    const listener = mock(() => {});
    const unsubscribe = subscribeLibraryChanges(listener);

    unsubscribe();
    publishLibraryChanged();

    expect(listener).not.toHaveBeenCalled();
  });
});
