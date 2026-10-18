/**
 * Dois modos de uso, mutuamente exclusivos:
 *
 * - **edição**: desenhar — arrastar nós, ligar portas, renomear, configurar
 *   comando/condição, excluir.
 * - **execução**: rodar — o canvas é travado e clicar no nó de início dispara o
 *   fluxo.
 *
 * O modo é estado de interface, não do documento: ele não entra no store, não
 * vira ponto de undo e não é salvo com o diagrama.
 */

export type Mode = 'edit' | 'run';

export const MODE_LABEL: Record<Mode, string> = {
  edit: 'Edição',
  run: 'Execução',
};

export class ModeController {
  private current: Mode = 'edit';

  constructor(
    private readonly app: HTMLElement,
    private readonly onChange: (mode: Mode) => void,
  ) {
    this.apply();
  }

  get mode(): Mode {
    return this.current;
  }

  get isEdit(): boolean {
    return this.current === 'edit';
  }

  set(mode: Mode): void {
    if (mode === this.current) return;
    this.current = mode;
    this.apply();
    this.onChange(mode);
  }

  toggle(): void {
    this.set(this.current === 'edit' ? 'run' : 'edit');
  }

  private apply(): void {
    this.app.dataset.mode = this.current;
  }
}