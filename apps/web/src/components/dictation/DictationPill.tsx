import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";

const TAIL_CHARACTERS = 60;

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Holds a recording while the text box it started in is off screen, so dictation goes on as the
 * user moves around the app. Returning to the box shows the words there again instead.
 */
export function DictationPill(props: {
  readonly startedAt: number;
  readonly transcript: string;
  readonly finishing: boolean;
  readonly onInsert: () => void;
  readonly onDiscard: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const text = props.transcript.trim();
  const tail = text.length > TAIL_CHARACTERS ? `…${text.slice(-TAIL_CHARACTERS)}` : text;

  return (
    <div
      role="status"
      aria-label="Dictating"
      className="fixed right-4 bottom-4 z-50 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-2 rounded-full border bg-popover py-1 ps-3 pe-1 text-popover-foreground text-sm shadow-lg"
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {elapsedLabel(now - props.startedAt)}
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{tail || "Listening…"}</span>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={props.finishing}
        // Keeps focus in the text box the words should go into.
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onInsert}
      >
        Insert
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Discard dictation"
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onDiscard}
      >
        <XIcon />
      </Button>
    </div>
  );
}
