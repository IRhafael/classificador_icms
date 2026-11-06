# Classificador ICMS PI

Aplicação estática para conferir o ICMS das saídas de planilhas de produtos (regras do Piauí), revisar NCM e consultar GTIN. O navegador processa os arquivos localmente; a tabela NCM oficial (Siscomex) vem empacotada em `assets/js/ncm-data.js`. As consultas de GTIN podem usar o Cadastro Centralizado de GTIN (CCG) oficial da SEFAZ e, como alternativa gratuita, o PreçoMelhor.

## Estrutura

```
index.html
assets/styles.css
assets/vendor/xlsx.full.min.js   SheetJS (leitura e gravação de planilhas)
assets/js/database.js            regras por NCM (CST, alíquota, observação)
assets/js/ncm-rules.js           coerência NCM × descrição do produto
assets/js/classification.js      núcleo da classificação (sem DOM)
assets/js/ncm-normalizer.js      revisão de NCM por produto
assets/js/ncm-data.js            tabela NCM oficial (Siscomex)
assets/js/ncm-api.js             consulta à tabela NCM local
assets/js/gtin-data.js           tabela GTIN → NCM fixa (opcional)
assets/js/gtin.js                base GTIN, SEFAZ e PreçoMelhor
assets/js/app.js                 interface
sefaz-bridge/server.mjs          conector local para a consulta GTIN da SEFAZ
```

## Como a conferência funciona

- **Operações internas (CFOP 5xxx):** aplica a regra do banco para o NCM (ou a regra por descrição, quando o mesmo NCM abriga produtos com tratamentos diferentes) e compara CST, alíquota, base e ICMS.
- **Interestaduais (CFOP 6xxx):** a regra interna não é aplicada. Para produto tributado, confere a alíquota interestadual de saída do PI (12%, ou 4% para importados) e calcula a diferença. CST, benefício, ST por convênio/protocolo e DIFAL ficam marcados para revisão.
- **Exportação (7xxx) e CFOPs de entrada (1/2/3xxx):** só ficam marcados para revisão.
- **Consolidação:** linhas do mesmo produto, NCM, CST, alíquota, CFOP e situação são somadas (coluna Nº LINHAS). Linhas com resultados diferentes (por exemplo, uma correta e outra divergente) ficam separadas.

## Publicar no GitHub Pages

1. Envie o código para a branch `main` ou `master`.
2. No GitHub, abra **Settings → Pages** e escolha **GitHub Actions** em “Build and deployment”.
3. O workflow `.github/workflows/pages.yml` publica o site a cada push (ou em **Actions → Run workflow**). Ele deve publicar só `index.html` e `assets/`; planilhas, certificados e a pasta `sefaz-bridge/` não vão para o site.
4. O endereço aparecerá em **Settings → Pages**.

## Consulta oficial de GTIN pela SEFAZ

A SEFAZ exige certificado ICP-Brasil A1 de contribuinte emitente de NF-e/NFC-e, TLS mútuo e SOAP (NT 2022.001). Uma página estática não consegue apresentar o certificado ao Web Service; por isso, a consulta passa pelo conector local em `sefaz-bridge/server.mjs`.

1. Instale Node.js 18 ou superior.
2. Abra o PowerShell na pasta do projeto e informe de onde a página será aberta:

   ```powershell
   # Site publicado: só esquema + domínio, sem o caminho do repositório
   $env:SEFAZ_ALLOWED_ORIGINS = 'https://SEU-USUARIO.github.io'
   # Página aberta direto do disco (file://): use null
   # $env:SEFAZ_ALLOWED_ORIGINS = 'null'
   # As duas formas: 'https://SEU-USUARIO.github.io,null'
   node .\sefaz-bridge\server.mjs
   ```

3. **Cadeia ICP-Brasil.** O servidor da SEFAZ usa certificado SSL da ICP-Brasil, que o Node não reconhece sozinho (erro `unable to get local issuer certificate`). Na primeira execução o conector baixa o arquivo único do ITI (`ACcompactado.zip`), confere o SHA-512 publicado e guarda em `sefaz-bridge/ca/`. Ao iniciar, ele testa a conexão e mostra no terminal:
   - `✓ Conexão segura com dfe-servico.svrs.rs.gov.br reconhecida.` — tudo certo;
   - `✗ Cadeia do servidor da SEFAZ NÃO reconhecida` — baixe manualmente o arquivo em [gov.br/iti → Repositório → Certificados das ACs da ICP-Brasil – Arquivo Único Compactado](https://www.gov.br/iti/pt-br/assuntos/repositorio/certificados-das-acs-da-icp-brasil-arquivo-unico-compactado), coloque o `.zip` (sem descompactar) na pasta `sefaz-bridge/ca/` e reinicie o conector. Arquivos `.crt`, `.cer` e `.pem` soltos nessa pasta também são lidos.

4. O conector imprime um token no terminal. Cole-o na tela do classificador, selecione o certificado `.pfx`/`.p12`, informe a senha e clique **Conectar**. A opção **Consultar na SEFAZ pelo certificado** é marcada automaticamente.

### Configuração para cada pessoa que usar o site

O GitHub Pages hospeda somente a interface. Cada usuário que quiser consultar a SEFAZ precisa, no próprio computador:

1. Baixar o ZIP do repositório pelo botão **Code → Download ZIP** e extrair a pasta completa (incluindo `sefaz-bridge/`). Instalar Node.js 18 ou superior.
2. Abrir PowerShell na pasta extraída e iniciar o conector:

   ```powershell
   $env:SEFAZ_ALLOWED_ORIGINS = 'https://irhafael.github.io'
   node .\sefaz-bridge\server.mjs
   ```

3. Aguardar a verificação/instalação automática da cadeia ICP-Brasil e manter o terminal aberto. Copiar o valor impresso após `Token desta execução:`.
4. No site publicado, colar o token, carregar o próprio certificado `.pfx`/`.p12`, digitar a senha e clicar **Conectar**. Marcar **Consultar na SEFAZ pelo certificado** para fazer consultas.

O token é gerado pelo conector local para proteger a conexão com o navegador; **não é um token fornecido pela SEFAZ**. A SEFAZ autentica a consulta pelo certificado A1 do contribuinte emitente de NF-e/NFC-e. O token muda ao reiniciar o conector. Cada usuário deve usar o próprio certificado e não compartilhar token, certificado ou senha. Se o conector for encerrado, a pessoa precisa iniciá-lo e conectar novamente.

O certificado e a senha ficam somente na memória do processo local e são apagados ao encerrá-lo com Ctrl+C. O conector escuta apenas em `127.0.0.1`; não exponha a porta 8787 nem compartilhe o token. Para usar um token fixo:

```powershell
$env:SEFAZ_BRIDGE_TOKEN = 'escolha-um-token-longo'
```

Limites para evitar rejeição por consumo indevido: uma consulta por segundo e até 100 por lote. Só GTINs brasileiros (prefixo 789/790) são enviados, porque a CCG não tem os demais. As respostas ficam guardadas no navegador por 30 dias (as de “não encontrado”, por 1 dia). Retornos tratados:

| cStat | Tratamento |
|---|---|
| 9490 | Encontrado: descrição, NCM e CEST |
| 9497 / 9498 | Encontrado, mas sem NCM válido no CCG |
| 9491, 9492, 9494, 9495, 9496 | Sem dados para o GTIN; segue para o próximo |
| 9493, 108, 109 e outros | Interrompe o lote (certificado não é emitente, serviço paralisado etc.) |

## Dados e privacidade

- As planilhas são lidas no navegador e não são enviadas a nenhum servidor.
- Com a opção do PreçoMelhor marcada, os códigos GTIN sem cadastro na base são enviados a esse serviço gratuito (60 por lote). Ele é um cadastro colaborativo e erra o NCM com frequência, por isso o NCM dele **nunca substitui** o informado: aparece só como referência na observação e na aba Validação GTIN. Só a base própria (XML de entrada / planilha importada) e a SEFAZ trocam o NCM automaticamente.
- Base GTIN, revisões de NCM, regras personalizadas e caches ficam no `localStorage` do navegador e do endereço atual. Ao trocar de `file://` para o GitHub Pages, esses dados não migram: use **Exportar base** e importe a planilha no outro endereço.

## Abrir localmente

Abra `index.html` em um navegador moderno. Para consultar na SEFAZ, inicie também o conector com `SEFAZ_ALLOWED_ORIGINS = 'null'`.
