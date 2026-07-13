-- 0029_license_device_revoked — fecha uma lacuna do reforço de licenciamento (0028):
-- `refreshLicenseFromCloud` tratava qualquer resposta não-OK do /validate (rede fora
-- do ar OU dispositivo revogado pelo suporte) do mesmo jeito: "mantém o estado local
-- e segue". Isso significa que remover o dispositivo no painel cloud não bloqueava
-- de fato a máquina antiga — ela continuava com o último `valid_until` em cache.
-- `device_revoked_at`: carimbado quando o cloud confirma 403 device_revoked (sinal
-- autoritativo, não falha de rede) — `validateLicense()` passa a checar isso e
-- retorna `bloqueada` permanentemente até o suporte liberar de novo.
ALTER TABLE license ADD COLUMN device_revoked_at TEXT;
