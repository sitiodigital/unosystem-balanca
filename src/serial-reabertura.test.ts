import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deveReutilizarConexao,
  erroAberturaSerialTransiente,
} from './serial-reabertura.ts';

const config = {
  port: 'COM3',
  baudRate: 9600,
  dataBits: 8 as const,
  parity: 'none' as const,
  stopBits: 1 as const,
};

describe('reabertura da porta serial no Windows', () => {
  it('reutiliza a porta já aberta com a mesma configuração', () => {
    assert.equal(
      deveReutilizarConexao(true, config, { ...config }),
      true,
    );
  });

  it('não reutiliza quando a porta foi fechada', () => {
    assert.equal(deveReutilizarConexao(false, config, { ...config }), false);
  });

  it('não reutiliza quando a configuração mudou', () => {
    assert.equal(
      deveReutilizarConexao(true, config, { ...config, baudRate: 4800 }),
      false,
    );
  });

  it('trata SetCommState 31 como falha transitória de reabertura', () => {
    assert.equal(
      erroAberturaSerialTransiente(
        'Open (SetCommState): Unknown error code 31',
      ),
      true,
    );
  });

  it('não trata acesso negado como falha transitória de SetCommState', () => {
    assert.equal(
      erroAberturaSerialTransiente('Opening COM3: Access denied'),
      false,
    );
  });
});
