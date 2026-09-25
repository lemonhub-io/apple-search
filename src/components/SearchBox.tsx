import type { RefObject } from "react";
import { ClearIcon, MagIcon } from "./icons";

interface Props {
  input: string;
  onInput: (v: string) => void;
  onSubmit: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  compact: boolean;
  /// Skip autofocus while the onboarding overlay is up — the field is
  /// covered, so focusing it would send keystrokes to a hidden element.
  autoFocus?: boolean;
}

/// Hero headline plus the search form. `compact` collapses the hero once
/// results (or a request) take over the page.
export function SearchBox({ input, onInput, onSubmit, inputRef, compact, autoFocus = true }: Props) {
  return (
    <>
      <div className={`hero-wrap${compact ? " collapsed" : ""}`}>
        <div className="hero">
          <h1 className="headline">Search the web.</h1>
        </div>
      </div>

      <form
        className="box"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <MagIcon className="box-icon" />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => onInput(e.target.value)}
          placeholder="Search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-label="Search query"
          autoFocus={autoFocus}
        />
        {input ? (
          <button type="button" className="clear" aria-label="Clear" onClick={() => onInput("")}>
            <ClearIcon />
          </button>
        ) : (
          <kbd className="kbd">/</kbd>
        )}
      </form>
    </>
  );
}
