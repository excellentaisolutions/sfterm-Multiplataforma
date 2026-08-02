/** Estado mínimo y comprobable para no enviar preediciones de un IME al PTY. */
export class TerminalCompositionState {
  private composing = false;

  start() {
    this.composing = true;
  }

  end() {
    this.composing = false;
  }

  /**
   * `isComposing` pertenece al InputEvent, no al textarea. Algunos webviews
   * emiten además un input final después de compositionend y otros esperan al
   * siguiente task; en ambos casos solo se devuelve el valor confirmado.
   */
  input(value: string, eventIsComposing = false): string | null {
    if (this.composing || eventIsComposing || !value) return null;
    return value;
  }

  /** keyCode 229 es la tecla virtual con la que Chromium/WebView2 conduce IME. */
  ownsKeydown(eventIsComposing: boolean, keyCode: number): boolean {
    return this.composing || eventIsComposing || keyCode === 229;
  }
}

/** Misma normalización que xterm.js: LF y CRLF se convierten en CR de terminal. */
export function terminalPastePayload(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r?\n/g, "\r");
  return bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;
}
