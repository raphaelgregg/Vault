/** Ponto de entrada da camada financeira: registra as operações e expõe o handler HTTP agnóstico. */
import './ops.mjs';
export { handleFinance, FinanceError, registry } from './core.mjs';
