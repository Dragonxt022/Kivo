-- 0074_license_tolerance_3 — tolerância de bloqueio após o vencimento: 7 → 3 dias.
--
-- Antes o Kivo dava 7 dias de "tolerância" contados da ÚLTIMA VALIDAÇÃO online, o que na
-- prática nunca bloqueava: o prazo deslizava a cada sync (o cloud responde 200 mesmo com a
-- licença vencida) e a máquina online ficava em tolerância para sempre. Agora a tolerância
-- é contada do fim da assinatura (`valid_until`) e passa a ser de 3 dias — ver
-- core/license/service.ts.
UPDATE license SET offline_grace_days = 3;
