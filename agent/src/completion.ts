import { CombinedAutocompleteProvider, Editor, getKeybindings, matchesKey, type AutocompleteItem, type AutocompleteSuggestions } from "@earendil-works/pi-tui";

const SLASH_TOKEN = /(?:^|\s)(\/[^\s/]*)$/u;
const OPEN_QUOTED_PATH = /(?:^|\s)@"[^"]*$/u;
const CONTROL = /[\x00-\x1f\x7f]/u;

type EditorInternals = { tryTriggerAutocomplete(): void; cancelAutocomplete(): void };

export function inlineSlashToken(lines: readonly string[], cursorLine: number, cursorCol: number): string | undefined {
  const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
  const token = SLASH_TOKEN.exec(before)?.[1];
  if (token === undefined) return undefined;
  if (cursorLine === 0 && before.slice(0, before.length - token.length).trim() === "") return undefined;
  return token;
}

export class RxAutocompleteProvider extends CombinedAutocompleteProvider {
  override async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    const token = inlineSlashToken(lines, cursorLine, cursorCol);
    if (token === undefined) return super.getSuggestions(lines, cursorLine, cursorCol, options);
    const commands = await super.getSuggestions([token], 0, token.length, { ...options, force: false });
    const name = token.slice(1).toLowerCase();
    const items = commands?.items.filter((item) => item.value.toLowerCase().startsWith(name)) ?? [];
    if (commands && items.length > 0) return { ...commands, items };
    return options.force ? super.getSuggestions(lines, cursorLine, cursorCol, options) : null;
  }

  override applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number } {
    if (item.value.includes("/") || inlineSlashToken(lines, cursorLine, cursorCol) !== prefix) return super.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol - prefix.length);
    const next = [...lines];
    next[cursorLine] = `${before}/${item.value} ${line.slice(cursorCol)}`;
    return { lines: next, cursorLine, cursorCol: before.length + item.value.length + 2 };
  }
}

export class RxEditor extends Editor {
  override handleInput(data: string): void {
    const internals = this as unknown as EditorInternals;
    const keys = getKeybindings();
    const showing = this.isShowingAutocomplete();
    if (showing && keys.matches(data, "tui.select.confirm") && this.slashToken() !== undefined) {
      super.handleInput("\t");
      return;
    }
    if (showing && keys.matches(data, "tui.editor.undo")) {
      super.handleInput(data);
      internals.cancelAutocomplete();
      return;
    }
    const text = this.getText();
    super.handleInput(data);
    if (this.getText() === text) return;
    if (showing && (data === " " || matchesKey(data, "shift+space")) && !OPEN_QUOTED_PATH.test(this.textBeforeCursor())) {
      internals.cancelAutocomplete();
      return;
    }
    const typed = [...data].length === 1 && !CONTROL.test(data);
    if (!this.isShowingAutocomplete() && (typed || keys.matches(data, "tui.editor.deleteCharBackward")) && this.slashToken() !== undefined) internals.tryTriggerAutocomplete();
  }

  private slashToken(): string | undefined {
    const { line, col } = this.getCursor();
    return inlineSlashToken(this.getLines(), line, col);
  }

  private textBeforeCursor(): string {
    const { line, col } = this.getCursor();
    return (this.getLines()[line] ?? "").slice(0, col);
  }
}
