# Servidores do Achados Baratos

São três servidores independentes, um por loja, feitos do mesmo código. O app chama os três ao mesmo tempo e mostra o link do produto mais barato.

| Servidor | Loja | O que precisa |
|---|---|---|
| achados-mercadolivre | Mercado Livre | Client ID e Secret do app em developers.mercadolivre.com.br |
| achados-shopee | Shopee | App ID e Secret da API de Afiliados (conta aprovada em affiliate.shopee.com.br) |
| achados-shein | Shein | Token do Apify (apify.com), serviço pago por uso. Sem ele a Shein fica fora da comparação |

## Colocar no ar (Render)
1. Crie uma conta em https://github.com e um repositório novo (https://github.com/new). Envie o conteúdo desta pasta (sem o arquivo `.env`).
2. Crie uma conta em https://render.com e abra https://dashboard.render.com/blueprints. Clique em New Blueprint Instance e escolha o repositório.
3. O Render cria os 3 servidores a partir do `render.yaml`. Preencha as chaves de cada um quando ele pedir. Quem ficar sem chave simplesmente não entra na comparação.
4. Cada servidor recebe um endereço, como `https://achados-shopee.onrender.com`. Abra `/api/saude` em cada um: deve aparecer `"ok":true`.
5. Coloque os 3 endereços no app, no começo do script do `public/index.html`:
   `const SERVIDORES={ml:'https://...',shopee:'https://...',shein:'https://...'};`
   (ou me mande os endereços que eu faço isso).
6. Abra o app pelo endereço de qualquer um dos servidores. Ele já traz o app junto.

## Teste rápido
`/api/loja/ml?q=fone bluetooth&min=40&max=120` (ou `shopee`, `shein` no servidor correspondente) devolve os produtos em JSON.

## Observações
- Cache de 10 minutos (30 na Shein) e limites de busca por minuto por pessoa.
- No plano grátis do Render os servidores "dormem" depois de um tempo parado, e a primeira busca demora cerca de 30 segundos. O plano grátis também tem um limite mensal de horas.
- Quer um servidor único com tudo? Deixe `LOJA` vazio e cadastre todas as chaves nele.
