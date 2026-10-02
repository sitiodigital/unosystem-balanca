export interface ConfigSerialComparavel {
  port: string;
  baudRate: number;
  dataBits: number;
  parity: string;
  stopBits: number;
}

export function mesmaConfiguracaoSerial(
  atual: ConfigSerialComparavel,
  solicitada: ConfigSerialComparavel,
): boolean {
  return (
    atual.port === solicitada.port &&
    atual.baudRate === solicitada.baudRate &&
    atual.dataBits === solicitada.dataBits &&
    atual.parity === solicitada.parity &&
    atual.stopBits === solicitada.stopBits
  );
}

/**
 * No Windows, fechar a COM e abrir de novo faz o SetCommState falhar com
 * error code 31. Enquanto a porta seguir aberta com a mesma configuração,
 * a leitura seguinte deve reutilizar o handle.
 */
export function deveReutilizarConexao(
  portaAberta: boolean,
  configAtual: ConfigSerialComparavel | null,
  configSolicitada: ConfigSerialComparavel,
): boolean {
  if (!portaAberta || !configAtual) {
    return false;
  }
  return mesmaConfiguracaoSerial(configAtual, configSolicitada);
}

export function erroAberturaSerialTransiente(mensagem: string): boolean {
  return /SetCommState/i.test(mensagem) && /error code 31/i.test(mensagem);
}
