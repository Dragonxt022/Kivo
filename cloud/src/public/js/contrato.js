/**
 * Helpers das telas de contrato (painel do cloud).
 *
 * Vive em arquivo próprio porque três telas usam a MESMA conta: a lista de contratos, a aba
 * Contratos da empresa e o detalhe do contrato. A prévia do bloco de parcelas precisa bater
 * com o que o servidor vai gerar (`parcelDates`, em `contracts.ts`) — dia 31 em mês de 30 cai
 * no último dia do mês, e é isso que o admin vê antes de confirmar.
 */
(function () {
  'use strict';

  /** "1.234,56" / "1234.56" → centavos (mesma regra do servidor). */
  function valorEmCentavos(v) {
    var s = String(v || '').replace(/[^\d,.]/g, '');
    var norm = s.indexOf(',') >= 0 ? s.replace(/\./g, '').replace(',', '.') : s;
    var n = parseFloat(norm);
    return isFinite(n) ? Math.round(n * 100) : 0;
  }

  function brl(cents) {
    return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  /** Vencimentos das parcelas: a primeira é a data informada; as outras no mesmo dia. */
  function vencimentos(primeiro, meses) {
    var partes = String(primeiro).split('-').map(Number);
    var a0 = partes[0], m0 = partes[1], d0 = partes[2];
    var datas = [];
    for (var i = 0; i < meses; i++) {
      var ano = a0 + Math.floor((m0 - 1 + i) / 12);
      var mes = ((m0 - 1 + i) % 12) + 1;
      var ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
      datas.push({ ano: ano, mes: mes, dia: Math.min(d0, ultimoDia) });
    }
    return datas;
  }

  function dataBr(d) {
    return String(d.dia).padStart(2, '0') + '/' + String(d.mes).padStart(2, '0') + '/' + d.ano;
  }

  /** Texto da prévia: o que será gerado, com primeira e última parcela. */
  function textoPrevia(meses, valorCents, primeiroVencimento) {
    if (!meses || !valorCents || !primeiroVencimento) {
      return 'Preencha prazo, valor e o primeiro vencimento para ver o que será gerado.';
    }
    var datas = vencimentos(primeiroVencimento, meses);
    return 'Serão geradas ' + meses + ' parcela(s) de ' + brl(valorCents) + ': a primeira vence em '
      + dataBr(datas[0]) + ' e a última em ' + dataBr(datas[datas.length - 1])
      + ' — total ' + brl(valorCents * meses) + '. Cada parcela já sai com Pix, boleto e cartão.';
  }

  /** Lê o arquivo escolhido e devolve só o base64 (sem o prefixo data:). */
  function arquivoEmBase64(arquivo) {
    return new Promise(function (resolve, reject) {
      var leitor = new FileReader();
      leitor.onload = function () {
        var texto = String(leitor.result || '');
        resolve(texto.slice(texto.indexOf(',') + 1));
      };
      leitor.onerror = reject;
      leitor.readAsDataURL(arquivo);
    });
  }

  /**
   * Manda o formulário como JSON (o PDF não caberia num POST de formulário: o corpo
   * urlencoded tem limite de 100kb) e segue o redirecionamento que o servidor devolve — é
   * ele que traz o aviso de sucesso ou o motivo do erro.
   */
  function enviarJson(url, dados, botao, rotuloOriginal) {
    if (botao) { botao.disabled = true; botao.textContent = 'Enviando…'; }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
      redirect: 'manual',
    }).then(function (r) {
      window.location.href = r.headers.get('location') || url;
    }).catch(function (e) {
      alert('Falha ao enviar: ' + e.message);
      if (botao) { botao.disabled = false; botao.textContent = rotuloOriginal || 'Enviar'; }
    });
  }

  function copiar(texto, botao, rotuloOriginal) {
    var feito = function () {
      if (!botao) return;
      var antes = botao.textContent;
      botao.textContent = 'Copiado!';
      setTimeout(function () { botao.textContent = rotuloOriginal || antes; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(feito).catch(function () { window.prompt('Copie o link:', texto); });
      return;
    }
    window.prompt('Copie o link:', texto);
  }

  window.Contrato = {
    valorEmCentavos: valorEmCentavos,
    brl: brl,
    vencimentos: vencimentos,
    textoPrevia: textoPrevia,
    arquivoEmBase64: arquivoEmBase64,
    enviarJson: enviarJson,
    copiar: copiar,
  };
})();
