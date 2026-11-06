# Classificador ICMS PI

Aplicação estática para classificar planilhas de produtos, revisar NCM e consultar GTIN. O navegador processa os arquivos localmente; as consultas podem usar o PreçoMelhor ou o Cadastro Centralizado de GTIN (CCG) oficial da SEFAZ.

## Publicar no GitHub Pages

1. Envie o código para a branch `main` ou `master`.
2. No GitHub, abra **Settings → Pages** e escolha **GitHub Actions** em “Build and deployment”.
3. O workflow `.github/workflows/pages.yml` publica o site automaticamente em cada push. Também é possível iniciá-lo em **Actions → Publicar no GitHub Pages → Run workflow**.
4. O endereço aparecerá em **Settings → Pages** e na execução do workflow.

O workflow publica somente `index.html` e `assets/`. Planilhas, certificados e outras ferramentas da raiz não entram no artefato do site.

## Consulta oficial de GTIN pela SEFAZ

A SEFAZ requer certificado ICP-Brasil A1 de contribuinte emitente de NF-e/NFC-e, TLS mútuo e SOAP. Uma página estática do GitHub Pages não consegue apresentar o certificado diretamente ao Web Service; por isso, a consulta passa pelo conector local em `sefaz-bridge/server.mjs`.

1. Instale Node.js 18 ou superior.
2. Abra PowerShell na pasta do projeto e defina a origem do seu Pages. Use apenas esquema + domínio; sem caminho do repositório:

   ```powershell
   $env:SEFAZ_ALLOWED_ORIGINS = 'https://SEU-USUARIO.github.io'
   node .\sefaz-bridge\server.mjs
   ```

3. O conector imprime um token no terminal. Cole-o na tela do classificador, selecione o certificado `.pfx`/`.p12`, informe a senha e clique **Conectar**.
4. Marque **Consultar na SEFAZ pelo certificado** para as consultas individuais ou planilhas.

O certificado e a senha ficam somente na memória do processo local e são apagados ao encerrá-lo com Ctrl+C. O conector escuta apenas em `127.0.0.1`; não exponha a porta 8787 nem compartilhe o token. Para definir um token seu antes de iniciar:

```powershell
$env:SEFAZ_BRIDGE_TOKEN = 'escolha-um-token-longo'
```

O conector limita as chamadas a uma por segundo e até 100 por lote para reduzir risco de rejeição por consumo indevido. O retorno pode incluir descrição, NCM e CEST. Certificados vencidos, sem chave privada, ou sem vínculo com emitente NF-e/NFC-e serão recusados pela consulta.

## Dados e privacidade

- As planilhas selecionadas são lidas no navegador e não são enviadas ao GitHub Pages.
- O código GTIN pode ser enviado ao PreçoMelhor, serviço gratuito opcional sujeito a limite de uso e variação de cobertura.
- Bases GTIN e regras personalizadas ficam no `localStorage` do navegador e domínio atual. Ao mudar de `file://` para o endereço GitHub Pages, esses dados locais não migram automaticamente.
- O projeto inclui uma base NCM oficial empacotada para consulta local. Confira a data indicada pela aplicação ao atualizar o arquivo.

## Abrir localmente

Abra `index.html` em um navegador moderno. Para consultar na SEFAZ, inicie também o conector conforme os passos acima.
