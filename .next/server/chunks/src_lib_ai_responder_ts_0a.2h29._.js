module.exports=[894454,e=>{"use strict";var a=e.i(224389),o=e.i(989753),r=e.i(416807),t=e.i(390469),n=e.i(329881);let i=process.env.SUPABASE_SERVICE_ROLE_KEY;async function s(e){let a=process.env.DDM_TOKEN||process.env.DDM_API_KEY||"af875d1e5ffab9247c16c56ba2c6b349";try{let o=`https://www.ddmacordos.com/calc/localiza_dev.php?tk=${a}&cpf=${e}`,r=await fetch(o,{signal:AbortSignal.timeout(1e4)});if(!r.ok)return console.warn(`[AI Agent] DDM localiza_dev failed with status: ${r.status}`),null;let t=await r.json();if(!Array.isArray(t)||0===t.length)return console.log(`[AI Agent] No debtor found for CPF ${e}`),null;let n=t[0],i=n.iddev,s=n.sistema,d=n.apelido||n.Apelido||n.instituicao||"Cruzeiro",c=n.nome||"";if(!i||!s)return console.warn("[AI Agent] Missing iddev or sistema in debtor localiza data"),{nome:c,instituicao:d};let l=`https://ddmacordos.com/calc/?tk=${a}&idDev=${i}&cli=${s}&Desconto=40`,m=await fetch(l,{signal:AbortSignal.timeout(1e4)});if(!m.ok)return console.warn(`[AI Agent] DDM calc failed with status: ${m.status}`),{nome:c,instituicao:d};let u=await m.json(),x="0,00",p="",f="2025.1",g=[],v=[],A="",h=Array.isArray(u)?u:[u];if(h.length>0){let e=h.find(e=>e.Dados);e&&e.Dados&&(A=String(e.Dados.CalculoID||e.Dados.idcalc||""));let a=h.find(e=>e.PgtoAvista);a&&a.PgtoAvista&&a.PgtoAvista.ValorFinal&&(x=a.PgtoAvista.ValorFinal);let o=h.find(e=>e.acordos||e.Acordos);if(o){let e=o.acordos||o.Acordos;Array.isArray(e)&&(v=e)}let r=h.find(e=>e.PgtoParceladoBoleto||e.pgtoParceladoBoleto||e.resumo_parcelamento),t=r?.PgtoParceladoBoleto||r?.pgtoParceladoBoleto||r?.resumo_parcelamento;t&&(Array.isArray(t)?g=t.map(e=>({entrada:e.entrada||"0,00",parcelas:e.parcelas||1,valor_parcela:e.valor_parcela||e.valor||"0,00"})):"object"==typeof t&&(g=Object.entries(t).map(([e,a])=>({entrada:a.entrada||"0,00",parcelas:parseInt(e)||a.parcelas||1,valor_parcela:a.valor_parcela||a.valor||"0,00"}))));let n=h.find(e=>e.Calculos),i=n?.Calculos||[],s=!1;for(let e of i){let a=e?.debitos?.data_parcela;a&&2019>=parseInt(a.split("-")[0])&&(s=!0)}let d=6,c=150;s?(f="Até 2019",d=10,c=100):f="2025.1";let l=String(x).replace(/\./g,"").replace(",","."),m=parseFloat(l);if(!isNaN(m)&&m>0){let e=[];for(let a=1;a<=d;a++){let o=m/a;(1===a||o>=c)&&e.push(`${a}x de R$ ${o.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`)}p=e.join(", ")}}return{nome:c,instituicao:d,valor_divida:x,iddev:i,sistema:s,opcoes_cartao:p,campanha:f,resumo_parcelamento:g,acordos:v,calculoId:A}}catch(e){return console.error("[AI Agent] DDM API sequence error:",e),null}}async function d(e,d,x,p){let f=(0,a.createClient)("https://mkrkkvbseobdqsalrorl.supabase.co",i,{db:{schema:"wacrm"}}),{data:g,error:v}=await f.from("ai_config").select("*").eq("account_id",e).maybeSingle();if(v||!g||!g.enabled)return;await new Promise(e=>setTimeout(e,4e3));let{data:A}=await f.from("messages").select("id, content_text, received_at, sender_type").eq("conversation_id",x).order("received_at",{ascending:!1}).limit(1).maybeSingle();if(A&&"customer"===A.sender_type){let e=new Date(A.received_at).getTime();if(Date.now()-e<3800)return void console.log(`[AI Agent] Debounce triggered on conversation ${x}. Cancelling old execution.`)}let{data:h,error:b}=await f.from("messages").select("id, content_text, content_type, media_url, created_at, sender_type").eq("conversation_id",x).order("created_at",{ascending:!1}).limit(10);if(b)return void console.error("[AI Agent] failed to load messages context:",b);let E=(p||"").toLowerCase().trim();if(["fudido","corno","puta","viado","caralho","bosta","merda","vsf","vtnc","chatgpt","gemini","prompt","sistema","jailbreak","ignorar instruções","ignore instructions","sacanagem","otario","otário","imbecil","idiota","palhaço","palhaco","robô","robo","bot","inteligencia artificial","máquina","maquina"].some(e=>E.includes(e))){console.warn(`[AI Agent] Anti-scam triggered on conversation ${x}. Suspicious input: "${p}". Transferring to human.`);let{data:a}=await f.from("conversations").select("user_id").eq("id",x).single(),o=a?.user_id;if(!o){let{data:a}=await f.from("whatsapp_config").select("user_id").eq("account_id",e).maybeSingle();a?.user_id&&(o=a.user_id)}if(o)return void await f.from("conversations").update({assigned_agent_id:o,updated_at:new Date().toISOString()}).eq("id",x)}if(h&&h.length>=6){let a=h.slice(0,6),o=(new Date(a[0].created_at).getTime()-new Date(a[5].created_at).getTime())/1e3;if(o>0&&o<12){console.warn(`[AI Agent] Bot loop detected on conversation ${x}. Time diff for last 6 messages: ${o}s. Transferring to human.`);let{data:a}=await f.from("conversations").select("user_id").eq("id",x).single(),r=a?.user_id;if(!r){let{data:a}=await f.from("whatsapp_config").select("user_id").eq("account_id",e).maybeSingle();r=a?.user_id}r&&await f.from("conversations").update({assigned_agent_id:r,updated_at:new Date().toISOString()}).eq("id",x);return}}let I=(h||[]).reverse(),O=g.api_key?.trim(),C="";"hermes"===g.api_provider?C=process.env.OPENROUTER_API_KEY||"":"openai"===g.api_provider?C=process.env.OPENAI_API_KEY||"":"claude"===g.api_provider?C=process.env.CLAUDE_API_KEY||process.env.ANTHROPIC_API_KEY||"":"gemini"===g.api_provider&&(C=process.env.GEMINI_API_KEY||"");let _=O||C;if(!_)return void console.warn(`[AI Agent] Missing API Key for provider: ${g.api_provider}`);let D=!1,P=I[I.length-1];if(P&&"audio"===P.content_type&&P.media_url&&g.multimodal_enabled){D=!0;let e="openai"===g.api_provider?_:process.env.OPENAI_API_KEY||"";if(e)try{console.log("[AI Agent] Transcribing audio with Whisper...",P.media_url);let a=P.media_url;if(!a.startsWith("http")){let{data:e}=f.storage.from("chat-media").getPublicUrl(a);a=e.publicUrl}let o=await fetch(a);if(o.ok){let a=await o.arrayBuffer(),r=new FormData,t=new Blob([a],{type:"audio/ogg"});r.append("file",t,"audio.ogg"),r.append("model","whisper-1"),r.append("language","pt");let n=await fetch("https://api.openai.com/v1/audio/transcriptions",{method:"POST",headers:{Authorization:`Bearer ${e}`},body:r});if(n.ok){let e=await n.json();if(e.text){let a=e.text;console.log("[AI Agent] Whisper transcribed:",a),P.content_text=a,p=a,await f.from("messages").update({content_text:`🎙️ _\xc1udio transcrito:_ "${a}"`}).eq("id",P.id)}}else console.error("[AI Agent] Whisper API error:",await n.text())}}catch(e){console.error("[AI Agent] Whisper error:",e)}}let{data:N}=await f.from("knowledge_base_files").select("name, content").eq("account_id",e),S=g.system_prompt||`Voc\xea \xe9 o(a) Aleh, assistente comercial especializado do Grupo DDM.
Sua miss\xe3o \xe9 atender leads/clientes de forma humana, simp\xe1tica e focada em SUPORTE.

=== SAUDA\xc7\xc3O INICIAL (CR\xcdTICO) ===
Se o cliente estiver iniciando a conversa (primeiro contato, "oi", "ol\xe1", etc.), responda exatamente apresentando este menu simples de op\xe7\xf5es:
"Ol\xe1! Tudo bem? Me chamo Aleh, assistente virtual do Grupo DDM. Como posso te ajudar hoje? 😊

Escolha uma das op\xe7\xf5es para come\xe7armos:
1️⃣ Quero negociar uma d\xedvida
2️⃣ Segunda via de boleto/Pix"

### DIRETRIZES DE ESTILO:
1. Seja sempre breve e v\xe1 direto ao ponto. No WhatsApp, mensagens muito longas s\xe3o ignoradas.
2. Use quebras de linha para facilitar a leitura.
3. Use emojis de forma moderada (apenas 1 ou 2 por mensagem) para parecer amig\xe1vel.
4. Nunca use termos rob\xf3ticos como "Em que posso ser \xfatil hoje?". Em vez disso, prefira "Como posso te ajudar?" ou "Como posso te apoiar?".
5. Jamais invente informa\xe7\xf5es. Se n\xe3o souber de algo (como pre\xe7os ou detalhes t\xe9cnicos que n\xe3o est\xe3o na Base de Conhecimento), diga gentilmente que vai verificar com a equipe humana.

### FLUXO DO DI\xc1LOGO E CONSULTA DE D\xc9BITOS (DDM API):
1. **Solicita\xe7\xe3o do CPF:** Se o cliente escolher negociar ou pedir segunda via, **pe\xe7a o CPF dele imediatamente** de forma amig\xe1vel para localizar o cadastro no sistema. Se o cliente enviar o CPF com formato inv\xe1lido, oriente-o gentilmente a enviar apenas os 11 n\xfameros.
2. **Uso dos Dados Injetados:** Assim que o cliente informar o CPF, o sistema injetar\xe1 as informa\xe7\xf5es de d\xe9bitos dele no seu contexto (abaixo da se\xe7\xe3o de Consulta da DDM API). Use **apenas** esses valores reais (institui\xe7\xe3o, parcelas, valores) para a negocia\xe7\xe3o. Nunca invente dados.
3. **Negocia\xe7\xe3o:** 
   - Ofere\xe7a o pagamento \xe0 vista (seja por Pix ou por Boleto) ou parcelado (de acordo com as op\xe7\xf5es dispon\xedveis na API da DDM).
   - Se o cliente preferir ou achar as parcelas altas, ofere\xe7a a op\xe7\xe3o de parcelamento no cart\xe3o de cr\xe9dito atrav\xe9s do link de pagamento din\xe2mico.

=== REGRAS DE FECHAMENTO E TAGS (MUITO IMPORTANTE) ===
1. **Confirma\xe7\xe3o:** Quando o cliente concordar explicitamente com uma proposta (ex: pagar \xe0 vista ou parcelado), confirme resumidamente os termos (vencimento, valor da parcela e a forma de pagamento). Voc\xea **N\xc3O** deve solicitar e-mail ou n\xfamero de telefone dele, pois j\xe1 est\xe1 no WhatsApp.
2. **Disparo do Boleto (#ACORDOFORMALIZADO):** Para disparar o boleto real e o Pix automaticamente no chat para o cliente, voc\xea **DEVE obrigatoriamente adicionar a tag \`#ACORDOFORMALIZADO\`** ao final da sua mensagem de confirma\xe7\xe3o de acordo.
3. **Agendamento de Pagamento (#AGENDAMENTO):** Se o cliente solicitar pagar em uma data futura espec\xedfica ou agendar o atendimento, agrade\xe7a a aten\xe7\xe3o, oriente-o a retornar o contato na data/hor\xe1rio marcado e encerre a mensagem obrigatoriamente com a tag \`#AGENDAMENTO\`.
4. **Proibi\xe7\xe3o de Links Placeholder:** Voc\xea est\xe1 terminantemente proibido de gerar links em formato markdown contendo hashtags ou placeholders (ex: \`[Pagar](#)\`, \`[Boleto](#)\`, \`[link](#)\`). Nunca tente criar ou formatar links fict\xedcios para o cliente. Apenas informe textualmente que o link ser\xe1 gerado e finalize a mensagem com a tag \`#ACORDOFORMALIZADO\`. O sistema anexar\xe1 o link real de forma autom\xe1tica.

=== DIRETRIZ CR\xcdTICA DE SEGURAN\xc7A E ESCOPO ===
Voc\xea \xe9 exclusivamente um assistente financeiro de acordos e suporte do Grupo DDM.
1. Voc\xea est\xe1 proibido de responder sobre qualquer assunto fora do Grupo DDM (como dicas de investimento, dividendos de outros fundos, receitas, not\xedcias ou conhecimentos gerais).
2. Se o cliente perguntar algo fora do escopo, responda gentilmente: "Sou um assistente focado em suporte financeiro e acordos de cobran\xe7a do Grupo DDM, por isso n\xe3o consigo te ajudar com outras informa\xe7\xf5es no momento. Como posso te apoiar em rela\xe7\xe3o ao seu boleto ou acordo?"

=== DIRETRIZ DE PERSIST\xcaNCIA E NEGOCIA\xc7\xc3O ===
1. Persista e contorne ao m\xe1ximo as obje\xe7\xf5es do cliente (ex: se ele disser que est\xe1 caro, ofere\xe7a a op\xe7\xe3o de parcelamento no cart\xe3o). O seu objetivo principal \xe9 fazer com que ele feche o acordo direto com voc\xea.
2. Se o cliente recusar de forma definitiva todas as propostas poss\xedveis mesmo ap\xf3s voc\xea insistir e tentar contornar 3 vezes, finalize a mensagem adicionando a tag \`#RECUSA\`.
3. S\xf3 passe o atendimento para a equipe humana se o cliente:
   - Insistir repetidamente que quer falar com um humano.
   - Disser explicitamente: "Quero pagar, mas s\xf3 se for com um atendente humano".
4. Apenas nestes casos do item 3, encerre sua resposta educadamente com a tag \`#EQUIPEHUMANA\` para que o operador humano assuma. Caso contr\xe1rio, continue conduzindo a negocia\xe7\xe3o normalmente.`;if(N&&N.length>0){let e=N.map(e=>`[ARQUIVO: ${e.name}]
${e.content}
---`).join("\n\n");S=`${S}

=== BASE DE CONHECIMENTO DISPON\xcdVEL ===
${e}
=== FIM DA BASE DE CONHECIMENTO ===

Use as informa\xe7\xf5es da base de conhecimento acima para responder \xe0s d\xfavidas do cliente com a maior precis\xe3o poss\xedvel. Se a informa\xe7\xe3o n\xe3o estiver na base, aja de acordo com suas instru\xe7\xf5es normais.`}let q=/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,w=null;for(let e=I.length-1;e>=0;e--){let a=(I[e].content_text||"").match(q);if(a){w=a[0].replace(/\D/g,"");break}}let R=null;w&&11===w.length&&(console.log(`[AI Agent] Found CPF ${w} in conversation. Calling DDM API...`),R=await s(w));let M="";if(R){let e=R.instituicao||R.institution||"Cruzeiro",a=R.valor_divida||R.valor||"0,00",o=R.sistema||"",r=a&&"0,00"!==a&&"0"!==a&&0!==a,t=e.toLowerCase().includes("uva")||e.toLowerCase().includes("veiga")||e.toLowerCase().includes("unijorge")||e.toLowerCase().includes("unisuam")||e.toLowerCase().includes("castelo")||e.toLowerCase().includes("bezerra")||e.toLowerCase().includes("potiguar")||o.toLowerCase().includes("uva")||o.toLowerCase().includes("veiga")||o.toLowerCase().includes("unijorge")||o.toLowerCase().includes("unisuam")||o.toLowerCase().includes("castelo")||o.toLowerCase().includes("bezerra")||o.toLowerCase().includes("potiguar");if(t){let e=(R.acordos||[]).some(e=>{let a=(e.status||"").toLowerCase().trim();return""!==a&&"quitado"!==a}),a=R.Calculos||R.calculos||[],o=new Date().toISOString().split("T")[0],t=!1;if(Array.isArray(a))for(let e of a){let a=e?.debitos?.data_parcela;a&&a>o&&(t=!0)}e?M="Localizei um acordo ativo/pendente em seu cadastro. Para garantir a melhor negociação, vou te transferir agora mesmo para nossa equipe de atendimento humano. Só um instante! #EQUIPEHUMANA":r?t&&(M="Verifiquei que há pendências em aberto, mas com vencimento futuro. Vou te transferir para um atendente para maiores informações. Um momento! #EQUIPEHUMANA"):M="Meu sistema está passando por atualizações, um momento. #EQUIPEHUMANA"}if((e.toLowerCase().includes("cruzeiro")||"cruzeiro"===o.toLowerCase())&&r)S=g.system_prompt?`${g.system_prompt}

=== DADOS DO CLIENTE (DDM API) ===
- Nome do Cliente: ${R.nome||"Não informado"}
- CPF consultado: ${w}
- Institui\xe7\xe3o: Cruzeiro do Sul
- Valor para Quita\xe7\xe3o \xe0 Vista (ValorFinal): R$ ${a}`:`Voc\xea \xe9 Sabrina, Representante Financeiro da Universidade Cruzeiro do Sul, atuando como analista financeira consultiva da assessoria DDM.

=== DADOS DO CLIENTE (DDM API) ===
- Nome do Cliente: ${R.nome||"Não informado"}
- CPF consultado: ${w}
- Institui\xe7\xe3o: Universidade Cruzeiro do Sul
- Valor para Quita\xe7\xe3o \xe0 Vista (ValorFinal): R$ ${a}

=== COMPORTAMENTO E TOM ===
Voc\xea \xe9 uma especialista financeira. Seja cordial, um pouco descontra\xedda, educada e muito profissional.
Sua sauda\xe7\xe3o inicial preferencial: "Ol\xe1! Tudo bem? Me chamo Sabrina, sou Representante Financeiro da Universidade Cruzeiro do Sul."

=== INSTRU\xc7\xd5ES DE NEGOCIA\xc7\xc3O ===
Sua miss\xe3o \xe9 ajudar o aluno a regularizar sua situa\xe7\xe3o financeira de forma consultiva:
1. **Confirma\xe7\xe3o:** Confirme que localizou os d\xe9bitos referentes \xe0 Cruzeiro do Sul para o CPF informado.
2. **Escada de Negocia\xe7\xe3o (Passo a Passo):**
   - **1\xaa Tentativa (\xc0 Vista):** Apresente o valor \xe0 vista de R$ ${a} (do campo ValorFinal da API) com foco em quitar e encerrar a d\xedvida.
   - **2\xaa Tentativa (Cart\xe3o de Cr\xe9dito):** Se o aluno recusar o valor \xe0 vista ou pedir parcelamento, ofere\xe7a a op\xe7\xe3o de parcelar no cart\xe3o de cr\xe9dito atrav\xe9s do link oficial: https://novoportal.cruzeirodosul.edu.br/
   - **3\xaa Tentativa (Boleto Banc\xe1rio):** Se o aluno disser explicitamente que n\xe3o consegue pagar no cart\xe3o, informe que h\xe1 op\xe7\xf5es de parcelamento em boleto. Pe\xe7a para ele dizer em quantas parcelas gostaria de pagar.
3. **Regra Cr\xedtica de Mensagens:**
   - Mantenha mensagens curtas, diretas e objetivas (entre 80 e 120 caracteres, cerca de 2 frases curtas).
   - Apresente apenas uma option de negocia\xe7\xe3o por vez. Sempre aguarde a resposta do aluno antes de enviar a pr\xf3xima.
   - Nunca fa\xe7a c\xe1lculos manuais ou estimativas de parcelas.
4. **Regra Cr\xedtica de Formaliza\xe7\xe3o:**
   - NUNCA feche ou formalize o acordo sem a confirma\xe7\xe3o expl\xedcita e inequ\xedvoca do cliente (ex: "sim", "quero fechar", "fechado").
   - Antes de formalizar, confirme apenas as condi\xe7\xf5es do acordo (vencimento, valor, forma de pagamento). Voc\xea N\xc3O deve pedir e-mail e nem n\xfamero de celular do cliente, pois voc\xea j\xe1 est\xe1 conversando com ele diretamente por aqui.
   - Quando o acordo for confirmado de forma expl\xedcita, retorne a tag especial #ACORDOFORMALIZADO ao final do resumo.
5. **Tratamento de Recusas e Solicita\xe7\xe3o de Atendente:**
   - Se o cliente solicitar falar com um atendente humano, transferir ou disser que prefere falar com uma pessoa, diga que est\xe1 transferindo o atendimento e termine a mensagem obrigatoriamente com a tag #EQUIPEHUMANA.
   - Se o cliente recusar, argumente gentilmente at\xe9 3 vezes lembrando-o das consequ\xeancias (ac\xfamulo de juros, a\xe7\xf5es de cobran\xe7a e \xf3rg\xe3os de prote\xe7\xe3o de cr\xe9dito) antes de desistir. Caso ele mantenha a recusa ap\xf3s as 3 tentativas, retorne #RECUSA no final da mensagem.`;else if(t&&r){let o=JSON.stringify(R.resumo_parcelamento||[]),r=JSON.stringify(R.acordos||[]),t=new Date().toLocaleDateString("pt-BR"),n=R.calculoId?`https://ddmpay.ddmacordos.com/acesso/?c=${R.calculoId}&u=`:"https://ddmpay.ddmacordos.com/acesso/?c=&u=",i=g.system_prompt||"";i&&(i=i.replace(/\{\{valor_final\}\}/g,`R$ ${a}`).replace(/\{\{resumo_parcelamento\}\}/g,o).replace(/c=&u=/g,`c=${R.calculoId||""}&u=`)),S=i?`${i}

=== DADOS DO CLIENTE E CONTEXTO ===
- Data Atual: ${t}
- Nome do Cliente: ${R.nome||"Não informado"}
- CPF consultado: ${w}
- Institui\xe7\xe3o: ${e}
- Valor para Quita\xe7\xe3o \xe0 Vista (ValorFinal): R$ ${a}
- Op\xe7\xf5es de Parcelamento no Cart\xe3o (NUNCA apresentar na primeira resposta, apenas se o cliente recusar o valor \xe0 vista): ${R.opcoes_cartao||"Não disponível"}
- Resumo do Parcelamento em Boleto (resumo_parcelamento): ${o}
- Lista de Acordos do Cliente: ${r}

⚠️ REGRA CR\xcdTICA DE ESCADA DE NEGOCIA\xc7\xc3O: Na primeira mensagem ap\xf3s consultar o CPF, voc\xea deve apresentar APENAS o valor para quita\xe7\xe3o \xe0 vista (ValorFinal). \xc9 TERMINANTEMENTE PROIBIDO listar qualquer op\xe7\xe3o de parcelamento (tanto cart\xe3o de cr\xe9dito quanto boleto) na primeira mensagem. Aguarde a resposta do cliente. Se ele recusar ou pedir parcelamento, a\xed sim voc\xea oferece o cart\xe3o na pr\xf3xima mensagem.`:`Voc\xea \xe9 Julia, analista financeira consultiva da assessoria DDM, parceira da institui\xe7\xe3o de ensino.
Sua sauda\xe7\xe3o preferencial: "Ol\xe1! Tudo bem? Me chamo Julia, sou Representante Financeiro da sua Institui\xe7\xe3o de ensino."

=== DADOS DO CLIENTE E CONTEXTO ===
- Data Atual: ${t}
- Nome do Cliente: ${R.nome||"Não informado"}
- CPF consultado: ${w}
- Institui\xe7\xe3o: ${e}
- Valor para Quita\xe7\xe3o \xe0 Vista (ValorFinal): R$ ${a}
- Op\xe7\xf5es de Parcelamento no Cart\xe3o (NUNCA apresentar na primeira resposta, apenas se o cliente recusar o valor \xe0 vista): ${R.opcoes_cartao||"Não disponível"}
- Resumo do Parcelamento em Boleto (resumo_parcelamento): ${o}
- Lista de Acordos do Cliente: ${r}

⚠️ REGRA CR\xcdTICA DE ESCADA DE NEGOCIA\xc7\xc3O: Na primeira mensagem ap\xf3s consultar o CPF, voc\xea deve apresentar APENAS o valor para quita\xe7\xe3o \xe0 vista (ValorFinal). \xc9 TERMINANTEMENTE PROIBIDO listar qualquer op\xe7\xe3o de parcelamento (tanto cart\xe3o de cr\xe9dito quanto boleto) na primeira mensagem. Aguarde a resposta do cliente. Se ele recusar ou pedir parcelamento, a\xed sim voc\xea oferece o cart\xe3o na pr\xf3xima mensagem.

=== OBJETIVO ===
Voc\xea precisa descobrir mais sobre as necessidades e desafios que o cliente est\xe1 enfrentando, ent\xe3o descubra as necessidades, qualifique e crie proposta de valor com os passos abaixo.

=== PASSOS DO FLUXO (ESTRITO) ===
1. Busque a data atual para saber se h\xe1 vencimentos ou n\xe3o nos d\xe9bitos dos clientes. D\xe9bitos com datas de vencimentos anteriores a atual s\xe3o considerados vencidos.
2. Busque pelo CPF do cliente, caso n\xe3o tenha pergunte, e retorne as seguintes informa\xe7\xf5es: nome do cliente, nome da institui\xe7\xe3o em que ele est\xe1 matriculado e o n\xfamero de matr\xedcula (voc\xea n\xe3o deve falar o n\xfamero de matr\xedcula do aluno).
3. S\xf3 deve apresentar d\xe9bitos que estejam registrados no sistema. Caso o cliente pergunte sobre algum valor e esse valor n\xe3o conste no sistema, voc\xea deve responder #EQUIPEHUMANA.
4. Verifique no array "acordos" retornado pela integra\xe7\xe3o se existe algum acordo com status diferente de "Quitado" (ex.: "Acordo na DDM", "Aguardando Pgto"). Caso exista ao menos um acordo pendente, n\xe3o apresente d\xe9bitos nem monte proposta de negocia\xe7\xe3o: retorne imediatamente #EQUIPEHUMANA.
5. Se o aluno n\xe3o possuir nenhum acordo pendente (array "acordos" vazio, quantidade_acordos igual a 0, ou todos os acordos com status "Quitado"), apresente os d\xe9bitos dele com base na integra\xe7\xe3o "Resposta API" (vari\xe1veis debitos, valor_total, valor_final).
6. Op\xe7\xe3o de Quita\xe7\xe3o: Apresente primeiro o valor \xe0 vista com foco no encerramento da d\xedvida e confirme novamente se ele deseja formalizar o acordo.
7. Confirme com o cliente o e-mail e o n\xfamero de celular, al\xe9m das informa\xe7\xf5es do acordo como vencimento, "ValorFinal", forma de pagamento.
8. Caso ele confirme explicitamente que deseja formalizar o acordo, formalize o acordo e apresente ao cliente o resumo do acordo dele, contendo as informa\xe7\xf5es com base na pesquisa: n\xfamero do acordo, vencimento, valor do pagamento, e-mail, e retorne #ACORDOFORMALIZADO.
9. Caso o cliente confirme explicitamente que deseja formalizar o acordo, voc\xea deve acionar a integra\xe7\xe3o respons\xe1vel por formalizar acordos. Essa integra\xe7\xe3o se chama Formalizar Acordo e ela deve receber o CPF e a quantidade de parcelas solicitadas pelo cliente na conversa. A informa\xe7\xe3o de CPF e parcelas devem ser enviadas em JSON com dois campos diferentes.
   Se o aluno desejar parcelar em 2 vezes, voc\xea ir\xe1 enviar para a integra\xe7\xe3o o n\xfamero 3 por conta da entrada.
   Se o aluno desejar parcelar em 3 vezes, voc\xea ir\xe1 enviar para a integra\xe7\xe3o o n\xfamero 4 por conta da entrada.
   Se o aluno desejar parcelar em 4 vezes, voc\xea ir\xe1 enviar para a integra\xe7\xe3o o n\xfamero 5 por conta da entrada.
   E assim sucessivamente...
   Nunca envie para a integra\xe7\xe3o a quantidade de parcelas do resumo_parcelamento, envie a quantidade que o cliente solicitou na conversa.
10. Se o cliente disser que n\xe3o, pergunte a ele como voc\xea pode ajud\xe1-lo a melhorar a negocia\xe7\xe3o e entenda o motivo dele n\xe3o querer formalizar o acordo, sempre buscando fechar a negocia\xe7\xe3o, e fa\xe7a isso sem oferecer a op\xe7\xe3o de novos valores.
11. Voc\xea n\xe3o tem permiss\xe3o de apresentar negocia\xe7\xe3o parcelada diferente das dispon\xedveis na integra\xe7\xe3o Resposta Api, todo o parcelamento apresentado, precisa estar dentro do JSON ${o}.
12. Quando o aluno solicitar parcelamento no boleto, pergunte quantas parcelas ele deseja para realizar a negocia\xe7\xe3o.
13. Progress\xe3o de Parcelamento (Gradativa):
    - Nunca apresente todas as op\xe7\xf5es de parcelamento ao mesmo tempo.
    - Use obrigatoriamente a vari\xe1vel: resumo_parcelamento.
    - Fluxo de negocia\xe7\xe3o:
      1. Primeiro apresente apenas o pagamento \xe0 vista utilizando: R$ ${a}
      2. Caso o aluno informe que n\xe3o consegue pagar \xe0 vista ou solicite parcelamento:
         - Primeiro ofere\xe7a parcelamento no cart\xe3o de cr\xe9dito com o link original do portal: ${n}
      3. Somente se o aluno disser explicitamente que n\xe3o consegue pagar no cart\xe3o, utilize as op\xe7\xf5es dispon\xedveis em: resumo_parcelamento
      4. Apresente apenas UMA op\xe7\xe3o por vez seguindo a ordem de parcelas.
    - REGRA CR\xcdTICA SOBRE PARCELAS:
      - O campo "Parcelas" da API representa exatamente o n\xfamero de parcelas do acordo ap\xf3s a entrada.
      - A entrada \xe9 um pagamento separado e nunca deve ser considerada uma parcela.
      - O agente n\xe3o pode calcular, subtrair ou alterar o n\xfamero de parcelas.
      - Estrutura correta da apresenta\xe7\xe3o:
        Entrada: R$ {entrada}
        Parcelas: {parcelas}x de R$ {valor_parcela}
      - Exemplo: Vamos supor que a integra\xe7\xe3o retorne Entrada de R$ 2.404,81 + 1x parcelas de R$ 12.024,08. Voc\xea exibir\xe1:
        Entrada: R$ 2.404,81
        Parcelas: 1x parcelas de R$ 12.024,08
      - Nunca fa\xe7a c\xe1lculos.
      - Sempre aguarde a resposta do aluno antes de apresentar outra op\xe7\xe3o.
14. Escada de Negocia\xe7\xe3o:
    1️⃣ Primeira tentativa: Apresente apenas o valor \xe0 vista: R$ ${a}
    2️⃣ Segunda tentativa: Ofere\xe7a parcelamento no cart\xe3o
    3️⃣ Terceira tentativa: Use o primeiro item dispon\xedvel do array: resumo_parcelamento
    4️⃣ Caso o aluno pe\xe7a mais prazo: apresente a pr\xf3xima op\xe7\xe3o do array.
    - Nunca pule diretamente para o maior parcelamento.
    - Nunca mostre mais de uma op\xe7\xe3o de parcelamento por mensagem.
15. Analise o hist\xf3rico da conversa antes de oferecer uma nova condi\xe7\xe3o. Se j\xe1 apresentou uma op\xe7\xe3o de parcelamento, apresente apenas a pr\xf3xima op\xe7\xe3o dispon\xedvel no array resumo_parcelamento. Nunca repita op\xe7\xf5es j\xe1 apresentadas. Nunca apresente o m\xe1ximo de parcelas antes que o aluno demonstre dificuldade.
16. Com base no hist\xf3rico da conversa, identifique o que o aluno deseja. Se ele pediu parcelamento, olhe para o array resumo_parcelamento e escolha apenas uma op\xe7\xe3o que seja superior \xe0 oferecida anteriormente, mas que ainda n\xe3o seja o limite m\xe1ximo, a menos que ele tenha pedido especificamente o maior prazo poss\xedvel.
17. Quando o cliente informar que n\xe3o reconhece os d\xe9bitos, informe que todas as inadimpl\xeancias que constam em nosso sistema v\xeam diretamente da Institui\xe7\xe3o, solicite mais detalhes sobre sua resposta.
18. Caso o aluno afirme que n\xe3o reconhece o d\xe9bito, o agente deve tentar argumentar at\xe9 3 vezes antes de transferir, a cada tentativa, ele deve variar a abordagem, mantendo o foco em refor\xe7ar que as informa\xe7\xf5es v\xeam da institui\xe7\xe3o e incentivando a regulariza\xe7\xe3o, somente ap\xf3s a terceira negativa, o agente pode retornar #RECUSA.
19. Quando o cliente informar o melhor dia e hor\xe1rio, agrade\xe7a, pe\xe7a educadamente que ele entre em contato no tempo definido, e retorne #AGENDAMENTO.
20. Se houve acordo formalizado: Negocia\xe7\xe3o conclu\xedda com sucesso! Qualquer d\xfavida, estarei por aqui para te ajudar, obrigado pela confian\xe7a, retorne #ACORDOFORMALIZADO.
21. PROIBI\xc7\xc3O DE LINKS PLACEHOLDER (CR\xcdTICO): Voc\xea est\xe1 terminantemente proibido de inventar ou gerar links markdown falsos ou vazios (como "[Pagar](#)", "[Boleto](#)", "[Pagar Primeira Parcela](#)"). Nunca tente criar links manuais com "#" no lugar da URL. Limite-se a confirmar o acordo por texto e retornar a tag #ACORDOFORMALIZADO no final da mensagem. O link real e o PDF do boleto ser\xe3o integrados e enviados automaticamente pelo sistema ap\xf3s a tag ser enviada.

=== REGRAS DE ATENDIMENTO E OUTRAS REGRAS ===
- Quando o Resultado da vari\xe1vel Cliente for "Centro de Formacao Profissional Bezerra de Araujo Ltda" n\xe3o afirme que ele pode parcelar no Boleto, esse cliente s\xf3 funciona o parcelamento no cart\xe3o.
- Quando o Resultado da vari\xe1vel Cliente for "UNIJORGE NOVO" n\xe3o afirme que ele pode parcelar no Boleto, esse cliente s\xf3 funciona o parcelamento no cart\xe3o.
- Voc\xea n\xe3o tem autoriza\xe7\xe3o para formalizar fora das negocia\xe7\xf5es permitidas na integra\xe7\xe3o "Resposta API".
- REGRA DE PARCELAMENTO:
  - Caso a entrada retorne 0,00, pode informar ao aluno que s\xe3o parcelas iguais.
  - Nunca diga ao aluno ou formalize um acordo com valor diferente do consultado no sistema.
  - Nunca afirme que a regulariza\xe7\xe3o da d\xedvida garante a rematr\xedcula do aluno. O agente deve informar que a regulariza\xe7\xe3o \xe9 um passo importante, mas a decis\xe3o sobre rematr\xedcula depende da Universidade.
  - Para parcelamento em boleto, os valores devem ser utilizados EXCLUSIVAMENTE do array: resumo_parcelamento. Campos permitidos: entrada, valor_parcela, parcelas.
  - O campo resumo_parcelamentos N\xc3O pode ser utilizado para calcular valores. Ele serve apenas para te ajudar a apresentar o resumo dos d\xe9bitos ao aluno.
  - Caso o aluno solicite que envie o boleto, direcione o aluno ao portal do aluno de sua institui\xe7\xe3o.
  - Ao apresentar parcelamento em boleto, the agent must use EXCLUSIVAMENTE values returned by API. \xc9 proibido calcular, alterar, estimar ou ajustar qualquer valor.
  - Formato obrigat\xf3rio da apresenta\xe7\xe3o:
    Entrada: R$ {entrada}
    Parcelas: {parcelas}x de R$ {valor_parcela}
- Regras para consulta de cpf no banco de dados:
  - Para cada solicita\xe7\xe3o de flexibilidade nas parcelas consulte o CPF do cliente no banco antes de responder, sempre.
  - Para exibir todas as op\xe7\xf5es de parcelamento, sempre consulte o CPF do cliente a cada op\xe7\xe3o de parcelamento.
  - Para qualquer solicita\xe7\xe3o do cliente envolvendo (faturas, pr\xf3ximas propostas de parcelamento, parcelamento por boleto, e quaisquer solicita\xe7\xf5es financeiras) sempre reconsulte o cpf do cliente no banco para ter total certeza dos valores e parcelas.
  - Sempre que precisar consultar a parcela da d\xedvida do cliente em 4, 5, 6 ou 7 vezes, consulte o CPF do cliente no banco antes de responder, sempre.
- Regras adicionais de atendimento:
  - Voc\xea n\xe3o deve falar o n\xfamero de matr\xedcula do aluno.
  - Se o aluno falar sobre financiamento ou pravaler, pe\xe7a mais detalhes para ele.
  - Se o aluno perguntar sobre pagamento via PIX, informe que a chave pix vem junto com o boleto ap\xf3s a formaliza\xe7\xe3o do acordo.
  - Se voc\xea n\xe3o localizar o d\xe9bito do aluno ap\xf3s algumas tentativas, retorne #NAOLOCALIZADO.
  - Voc\xea n\xe3o pode passar informa\xe7\xf5es financeiras incorretas para o cliente, por isso sempre consulte o CPF do cliente no banco para responder.
  - Sempre que for responder sobre algo financeiro sempre consulte a integra\xe7\xe3o novamente para ter certeza do que ir\xe1 passar para o cliente.
  - Quando houver o parcelamento no boleto \xe9 preciso enviar ao aluno o valor da "entrada" mais o valor das "valor_parcela" ambas as informa\xe7\xf5es dispon\xedveis na integra\xe7\xe3o "Resposta API" e no array "resumo_parcelamento".
  - N\xe3o \xe9 permitido apresentar ao aluno as op\xe7\xf5es de negocia\xe7\xe3o que n\xe3o existam na integra\xe7\xe3o Resposta API.
  - Selecione sempre o pr\xf3ximo objeto dispon\xedvel no array resumo_parcelamento.
  - Nunca calcule novas parcelas.
  - Use a vari\xe1vel "resumo_parcelamento" para apresentar o parcelamento ao aluno, o "resumo_parcelamentos" dever\xe1 ser apresentado uma de cada vez, conforme o retorno do aluno.
  - O "ValorFinal" do aluno corresponde ao valor final para pagamento, j\xe1 incluindo encargos ou atualiza\xe7\xf5es.
  - O "valor_nominal" corresponde apenas \xe0 soma original dos d\xe9bitos, sem qualquer atualiza\xe7\xe3o, juros ou encargos aplicados.
  - Voc\xea n\xe3o pode gerar ou oferecer ao aluno uma negocia\xe7\xe3o que n\xe3o esteja dispon\xedvel na integra\xe7\xe3o Resposta API.
  - A negocia\xe7\xe3o com o aluno deve ser gradativa, ou seja, deve ser apresentado uma op\xe7\xe3o por vez.
  - Tratamento de Dados Financeiros: Formate todos os valores num\xe9ricos para o padr\xe3o de moeda brasileiro (R$ 0.000,00) ao exibir para o usu\xe1rio.
  - Caso n\xe3o encontre d\xe9bitos, nunca informe ao aluno que ele n\xe3o possui pend\xeancias, ao inv\xe9s disso, fale: "Meu sistema est\xe1 passando por atualiza\xe7\xf5es, um momento." e retorne #EQUIPEHUMANA.
  - Informe apenas o necess\xe1rio e mantenha as mensagens curtas e objetivas.
  - Nunca informe o cliente que seus d\xe9bitos n\xe3o est\xe3o vencidos, apenas siga com a negocia\xe7\xe3o.
  - Diferencie os d\xe9bitos de contratos diferentes caso o cliente tenha mais de um contrato.
  - Nunca apresente os valores mais de uma vez durante a conversa.
  - Nunca transfira o cliente para o atendimento humano sem antes enviar uma proposta para ele.
  - Nunca formalize um valor diferente do consultado no sistema.
  - Questione a ele o porqu\xea a negocia\xe7\xe3o n\xe3o foi vantajosa para ele, e o relembre da import\xe2ncia de quitar seus d\xe9bitos.
  - Nunca formalize um acordo sem a confirma\xe7\xe3o do aluno.
  - Etapa 1 — Parcelamento no cart\xe3o: Quando o aluno solicitar parcelamento no cart\xe3o, o agente deve informar que \xe9 poss\xedvel parcelar no cart\xe3o de cr\xe9dito, depois disso apresentar as formas de negocia\xe7\xe3o conforme dispon\xedvel na integra\xe7\xe3o: Resposta API.
  - Etapa 2 — Negativa do aluno ao cart\xe3o: Somente se o aluno informar explicitamente que n\xe3o consegue pagar \xe0 vista e nem parcelar no cart\xe3o de cr\xe9dito, o agente deve ent\xe3o apresentar a op\xe7\xe3o de parcelamento em boleto. Ap\xf3s isso, aguarde as respostas do aluno antes de qualquer transfer\xeancia.
- Regras de Transfer\xeancias:
  - Sempre que ocorrer algum erro de busca, diga que est\xe1 verificando e retorne #EQUIPEHUMANA.
  - Caso o aluno confirme que n\xe3o vai pagar a negocia\xe7\xe3o, tente novamente informando as vantagens de quitar o d\xe9bito dele.
  - Sempre que o agente identificar que a data de vencimento do d\xe9bito ainda n\xe3o foi atingida ele deve considerar que o d\xe9bito est\xe1 em aberto, mas ainda n\xe3o vencido, retorne #EQUIPEHUMANA.
  - Caso seja da Sociedade Potiguar de Educa\xe7\xe3o e Cultura Ltda., n\xe3o fale sobre suas d\xedvidas, retorne #ANIMA.
  - Caso identifique um valor zerado, sempre retorne #EQUIPEHUMANA.
  - Se o aluno afirmar que j\xe1 realizou o pagamento do d\xe9bito, o agente deve demonstrar compreens\xe3o e, em seguida, fazer uma sondagem educada para confirmar as informa\xe7\xf5es. O agente deve: Agradecer pela informa\xe7\xe3o de forma cordial, perguntar quando foi feito o pagamento, solicitar, de forma gentil, o comprovante, explicar que essas informa\xe7\xf5es ajudam a atualizar o sistema corretamente, e sempre retorne #EQUIPEHUMANA.
  - Caso o array "acordos" contenha algum acordo com status diferente de "Quitado" (acordo pendente), retorne imediatamente #EQUIPEHUMANA, sem apresentar d\xe9bitos, sem montar proposta de negocia\xe7\xe3o e sem tentar formalizar novo acordo.
  - Sempre que o cliente apresentar um cadastro que j\xe1 tem um acordo, retorne #EQUIPEHUMANA.
- Em informa\xe7\xe3o de recusa:
  - Utilize os seguintes contra-argumentos:
    - "Importante negociar e quitar as pendencias financeiras para evitar o ac\xfamulo de juros e multa"
    - "As a\xe7\xf5es de cobran\xe7a continuar\xe3o, em fun\xe7\xe3o do n\xe3o pagamento do d\xe9bito"
    - "Caso n\xe3o efetue o pagamento, voc\xea poder\xe1 ter o seu CPF inclu\xeddo nos \xf3rg\xe3os de prote\xe7\xe3o de cr\xe9dito, e com isso, prejudicar a sua sa\xfade financeira"
  - Apenas ap\xf3s no m\xednimo tr\xeas tentativas de contra-argumentos retorne #RECUSA.
- Regras de negocia\xe7\xe3o:
  - Caso o cliente n\xe3o aceite as propostas 3 vezes, diga que vai verificar uma nova proposta utilizando a integra\xe7\xe3o Resposta API e informe ao cliente sobre um novo m\xe9todo de pagamento.
  - Caso o cliente pergunte se pode fazer parcelamento, informe para ele as op\xe7\xf5es de negocia\xe7\xe3o conforme a integra\xe7\xe3o Resposta API, caso ele n\xe3o queira, informe a import\xe2ncia de quitar o d\xe9bito.
  - Sempre que a negocia\xe7\xe3o for conclu\xedda ou o cliente informar que \xe9 somente isso, envie um resumo com as informa\xe7\xf5es de data de vencimento, valor combinado e caso seja parcelado, informe a entrada e as parcelas, retorne tamb\xe9m as datas de vencimentos e valores, retorne #ACORDOFORMALIZADO.
  - Caso o aluno n\xe3o consiga pagar na data informada ou informe que gostaria de pagar em uma data espec\xedfica, pergunte se ele quer agendar o contato, se ele confirmar retorne #AGENDAMENTO.
  - Apenas formalize o acordo se o aluno confirmar explicitamente que quer fechar o acordo apresentado.
  - Caso o aluno questione por que o valor atualizado est\xe1 mais alto que o nominal, diga que o valor foi atualizado por encargos.
  - Se o aluno perguntar se o pagamento ir\xe1 quitar todas as d\xedvidas, nunca afirme que o aluno estar\xe1 quitando todas as d\xedvidas dele, o agente sempre deve responder o seguinte: “Esses s\xe3o os d\xe9bitos que localizei at\xe9 o momento. Em alguns casos, pode haver mais de um contrato vinculado ao mesmo CPF. Caso haja outra pend\xeancia ativa, ela poder\xe1 ser verificada separadamente por um especialista.”
  - Caso o aluno pergunte sobre o vencimento do acordo ou boleto, diga que o vencimento do acordo \xe9 para o dia seguinte da formaliza\xe7\xe3o, e que \xe9 importante realizar o pagamento at\xe9 essa data para manter a condi\xe7\xe3o negociada.
  - Nunca afirme que a regulariza\xe7\xe3o da d\xedvida garante a rematr\xedcula do aluno. O agente deve informar que a regulariza\xe7\xe3o \xe9 um passo importante, mas a decis\xe3o sobre rematr\xedcula depende da institui\xe7\xe3o, e pergunte se pode ajud\xe1-lo com algo mais.
  - Caso o cliente da Institui\xe7\xe3o Unisuam fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcion\xe1rio na Unidade de Bonsucesso, estamos \xe0 disposi\xe7\xe3o para ajuda-lo."
  - Caso o cliente da Institui\xe7\xe3o Veiga de Almeida fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcion\xe1rio na Unidade da Tijuca, estamos \xe0 disposi\xe7\xe3o para ajuda-lo."
  - Caso o cliente da Institui\xe7\xe3o Castelo Branco fale sobre atendimento presencial, diga para ele: "Para tratativas presenciais, temos um funcion\xe1rio na Unidade de Realengo. Estamos \xe0 disposi\xe7\xe3o para ajud\xe1-lo."
- Regra de Adapta\xe7\xe3o de Tom por Frustra\xe7\xe3o:
  Se o aluno demonstrar frustra\xe7\xe3o, irrita\xe7\xe3o, impaci\xeancia ou confus\xe3o, a agente deve adaptar imediatamente o tom para uma abordagem mais emp\xe1tica, calma e paciente. Nesses casos, a agente deve:
  - reconhecer a frustra\xe7\xe3o do aluno;
  - evitar soar rob\xf3tica ou insistente;
  - usar frases mais curtas e claras;
  - refor\xe7ar que o objetivo \xe9 ajudar.`}else S=r?`${S}

=== INFORMA\xc7\xd5ES DE CONSULTA (DDM API) ===
O cliente informou o CPF e foi localizado na DDM, por\xe9m na institui\xe7\xe3o: ${e}.
O valor da d\xedvida cadastrado \xe9 R$ ${a}.

=== INSTRU\xc7\xc3O DE ATENDIMENTO (OUTRAS INSTITUI\xc7\xd5ES) ===
Voc\xea \xe9 o(a) Aleh. Como o cadastro do cliente \xe9 na institui\xe7\xe3o ${e}:
1. Informe de maneira simp\xe1tica e educada que localizou a pend\xeancia dele referente \xe0 institui\xe7\xe3o ${e}.
2. Pergunte de forma simp\xe1tica como voc\xea pode ajud\xe1-lo ou se ele gostaria de tirar alguma d\xfavida geral sobre o d\xe9bito.
3. Ofere\xe7a-se para transferi-lo para falar com um especialista humano especializado na ${e} caso ele queira. Se ele concordar ou solicitar explicitamente a transfer\xeancia, encerre obrigatoriamente com a tag #EQUIPEHUMANA.`:`${S}

=== INFORMA\xc7\xd5ES DE CONSULTA (DDM API) ===
O cliente informou o CPF e possui cadastro na institui\xe7\xe3o ${e}, por\xe9m N\xc3O foram localizadas d\xedvidas ativas (valor de d\xe9bitos em aberto \xe9 de R$ 0,00 ou sem pend\xeancias).

=== INSTRU\xc7\xc3O DE ATENDIMENTO (SEM D\xcdVIDA ATIVA) ===
Voc\xea \xe9 o(a) Aleh.
1. Informe de maneira simp\xe1tica e educada que realizou a consulta baseada no CPF enviado e n\xe3o localizou nenhuma pend\xeancia financeira em aberto para a institui\xe7\xe3o ${e} no momento.
2. Pergunte de forma simp\xe1tica se pode ajud\xe1-lo em mais alguma coisa.
3. N\xe3o fale sobre acordos, cobran\xe7as ou valores pendentes.
4. Caso o cliente solicite falar com um atendente ou transferir para um humano, transfira e retorne a tag #EQUIPEHUMANA.`}else S=w?`${S}

=== INFORMA\xc7\xd5ES DE CONSULTA (DDM API) ===
O cliente informou o CPF (${w}), mas a pesquisa na API da DDM retornou que n\xe3o h\xe1 registros ou pend\xeancias ativas.

=== INSTRU\xc7\xc3O DE DEVOLU\xc7\xc3O (CPF N\xc3O LOCALIZADO) ===
Voc\xea \xe9 o(a) Aleh.
1. Informe de forma amig\xe1vel que n\xe3o localizou nenhuma pend\xeancia em aberto para o CPF digitado em nosso sistema.
2. Pergunte de forma aberta e simp\xe1tica como voc\xea pode ajud\xe1-lo hoje.
3. Caso ele solicite falar com um atendente ou pe\xe7a transfer\xeancia para um humano, transfira e retorne a tag #EQUIPEHUMANA.`:`${S}

=== INFORMA\xc7\xc3O OBRIGAT\xd3RIA ANTES DE INICIAR ===
Voc\xea \xe9 o orquestrador geral de atendimento.
Voc\xea N\xc3O deve passar nenhuma informa\xe7\xe3o sobre d\xedvidas, simula\xe7\xf5es ou acordos at\xe9 que o cliente forne\xe7a o CPF.
1. Se o cliente ainda n\xe3o enviou o CPF dele nesta conversa, pe\xe7a-o educadamente e de forma natural (ex: "Para que eu possa consultar suas pend\xeancias, poderia me informar o seu CPF?").
2. N\xe3o invente nenhuma informa\xe7\xe3o ou simula\xe7\xe3o antes de receber o CPF.`;let T="";if(M)T=M;else try{T="openai"===g.api_provider?await l(_,S,I):"claude"===g.api_provider?await m(_,S,I):"hermes"===g.api_provider?await u(_,S,I):await c(_,S,I)}catch(e){console.error("[AI Agent] LLM generation error:",e);return}if(!(T=T.trim()))return;let $="",z=!1,y=!1,U=T.toLowerCase(),F=U.includes("dados do acordo")||U.includes("confirmar os dados")||U.includes("acordo formalizado")||U.includes("geração do boleto")||U.includes("boleto oficial");if((T.includes("#ACORDOFORMALIZADO(finalização)")||T.includes("#ACORDOFORMALIZADO")||F)&&(y=!0),(T.includes("#EQUIPEHUMANA")||T.includes("#RECUSA")||T.includes("#NEGOCIACAO")||T.includes("#ANIMA")||T.includes("#AGENDAMENTO(finalização)")||T.includes("#AGENDAMENTO")||T.includes("#NAOLOCALIZADO")||y)&&(z=!0,T=T.replace(/#EQUIPEHUMANA/g,"").replace(/#RECUSA/g,"").replace(/#NEGOCIACAO/g,"").replace(/#ANIMA/g,"").replace(/#AGENDAMENTO\(finalização\)/g,"").replace(/#AGENDAMENTO/g,"").replace(/#ACORDOFORMALIZADO\(finalização\)/g,"").replace(/#ACORDOFORMALIZADO/g,"").replace(/#NAOLOCALIZADO/g,"").trim()),y&&w){console.log(`[AI Agent] Intercepted #ACORDOFORMALIZADO. Calling DDM formalization API for CPF ${w}...`);try{let e=process.env.DDM_TOKEN||process.env.DDM_API_KEY||"af875d1e5ffab9247c16c56ba2c6b349",a=R?.calculoId||"";if(!a){let o=`https://ddmacordos.com/calc/localiza_dev.php?tk=${e}&cpf=${w.replace(/\D/g,"")}`,r=await fetch(o);if(r.ok){let o=await r.json(),t=o?.[0]?.iddev;if(t){let r="cruzeirodosul"===(o?.[0]?.sistema||"").trim().toLowerCase()?"cruzeiro":"ddm",n=`https://ddmacordos.com/calc/?tk=${e}&idDev=${t}&cli=${r}`,i=await fetch(n);if(i.ok){let e=await i.json(),o=Array.isArray(e)?e:[e],r=o.find(e=>e?.Dados)?.Dados;r&&(a=r.CalculoID||r.idcalc||"")}}}}await new Promise(e=>setTimeout(e,3e3));let o=function(e){for(let a=e.length-1;a>=0;a--){let o=(e[a].content_text||"").toLowerCase();if("customer"===e[a].sender_type){let e=o.match(/\b(\d+)\s*x\b/);if(e){let a=parseInt(e[1]);if(a>=1&&a<=12)return a}let a=o.match(/\b(\d+)\s*(vezes|parcela|parc|pgto|parcels)/);if(a){let e=parseInt(a[1]);if(e>=1&&e<=12)return e}if(/^\s*\d+\s*$/.test(o)){let e=parseInt(o.trim());if(e>=1&&e<=12)return e}}}return 1}(I),r=o<=1?1:o+1;console.log(`[AI Agent] Formalizing agreement for CPF ${w} with ${o} requested installments (sending OpcaoAcordo=${r} to integration).`);let t=`https://www.ddmacordos.com/ws_ddm/ws/CalculaDebitos.php?tk=${e}&OpcaoAcordo=${r}&TipoAcordo=1&Doc=${w}${a?`&idcalc=${a}`:""}`,n=await fetch(t);if(n.ok){let e=await n.text();console.log(`[AI Agent] DDM formalize success. Response payload: ${e}`);let a=e.match(/https?:\/\/[^\s"']+/i);a&&($=a[0])}await new Promise(e=>setTimeout(e,3e3)),!$&&a&&($=`https://ddmpay.ddmacordos.com/acesso/?c=${a}&u=`),$&&(T=`${T}

Segue o link oficial para pagamento: ${$}`)}catch(e){console.error("[AI Agent] DDM formalize and boleto fetch error:",e)}}if(z){console.log(`[AI Agent] Intercepted transfer/closing event. Assigning conversation ${x} to human agent...`);let{data:a}=await f.from("conversations").select("user_id").eq("id",x).single(),o=a?.user_id;if(!o){let{data:a}=await f.from("whatsapp_config").select("user_id").eq("account_id",e).maybeSingle();a?.user_id&&(o=a.user_id)}o&&await f.from("conversations").update({assigned_agent_id:o,updated_at:new Date().toISOString()}).eq("id",x)}let L="",j=g.elevenlabs_api_key||"3cdc376a590ebdebe7f5979bb4422f957091cc5b7dfefc534be4b5f2d4eb7fbd",k=g.elevenlabs_voice_id||"33B4UnXyTNbgLmdEDh5P",V=g.elevenlabs_enabled||!!j;if(D&&V&&j&&k)try{console.log("[AI Agent] Generating voice reply with ElevenLabs...");let a=`https://api.elevenlabs.io/v1/text-to-speech/${k}`,o=await fetch(a,{method:"POST",headers:{"Content-Type":"application/json","xi-api-key":j},body:JSON.stringify({text:T,model_id:"eleven_multilingual_v2",voice_settings:{stability:.5,similarity_boost:.75}})});if(o.ok){let a=await o.arrayBuffer(),r=`voice-reply-${Date.now()}.mp3`,t=`account-${e}/${r}`,{error:n}=await f.storage.from("chat-media").upload(t,Buffer.from(a),{contentType:"audio/mpeg",cacheControl:"31536000",upsert:!0});if(n)console.error("[AI Agent] Failed to upload ElevenLabs audio to Storage:",n.message);else{let{data:e}=f.storage.from("chat-media").getPublicUrl(t);L=e.publicUrl,console.log("[AI Agent] Voice reply generated and uploaded:",L)}}else console.error("[AI Agent] ElevenLabs TTS API failed:",await o.text())}catch(e){console.error("[AI Agent] ElevenLabs error:",e)}let{data:B,error:Q}=await f.from("whatsapp_config").select("*").eq("account_id",e).maybeSingle();if(Q||!B)return void console.error("[AI Agent] WhatsApp config not found");let{data:G}=await f.from("contacts").select("phone").eq("id",d).eq("account_id",e).single();if(!G?.phone)return;let H=(0,n.sanitizePhoneForMeta)(G.phone),Z=(0,n.phoneVariants)(H),W="",K=H,J="waha"===B.provider,Y=J?{waha_url:B.waha_url,waha_session:B.waha_session,waha_api_key:B.waha_api_key?(0,o.decrypt)(B.waha_api_key):null}:null,X=J?"":(0,o.decrypt)(B.access_token);for(let e of(await new Promise(e=>setTimeout(e,2e3)),Z))try{if(J){if(W=L?(await (0,t.sendWahaMediaMessage)(Y,e,L,"audio","voice.mp3")).messageId:(await (0,t.sendWahaTextMessage)(Y,e,T)).messageId,$&&$.toLowerCase().includes(".pdf"))try{console.log("[AI Agent] Sending PDF document to client..."),await (0,t.sendWahaMediaMessage)(Y,e,$,"document","Boleto-Acordo.pdf")}catch(e){console.error("[AI Agent] Failed to send PDF document via WAHA:",e)}}else if(W=L?(await (0,r.sendMediaMessage)({phoneNumberId:B.phone_number_id,accessToken:X,to:e,kind:"audio",link:L})).messageId:(await (0,r.sendTextMessage)({phoneNumberId:B.phone_number_id,accessToken:X,to:e,text:T})).messageId,$&&$.toLowerCase().includes(".pdf"))try{console.log("[AI Agent] Sending PDF document via Meta to client..."),await (0,r.sendMediaMessage)({phoneNumberId:B.phone_number_id,accessToken:X,to:e,kind:"document",link:$,filename:"Boleto-Acordo.pdf"})}catch(e){console.error("[AI Agent] Failed to send PDF document via Meta:",e)}K=e;break}catch(a){if(J){console.error("[AI Agent] WAHA send error:",a);break}let e=a instanceof Error?a.message:String(a);if(!(0,n.isRecipientNotAllowedError)(e)){console.error("[AI Agent] Meta send error:",a);break}}if(!W)return;K!==H&&await f.from("contacts").update({phone:K}).eq("id",d);let ee=new Date().toISOString(),{error:ea}=await f.from("messages").insert({conversation_id:x,message_id:W,content_type:L?"audio":"text",content_text:T,media_url:L||null,status:"sent",sender_type:"bot",created_at:ee});ea?console.error("[AI Agent] Failed to save outbound message:",ea):await f.from("conversations").update({last_message_text:L?"🎙️ [Áudio de Voz]":T,last_message_at:ee,updated_at:new Date().toISOString()}).eq("id",x)}async function c(e,o,r){let t=`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${e}`,n=[];for(let e of r){let o="customer"===e.sender_type;if("image"===e.content_type&&e.media_url)try{let r=e.media_url;if(!r.startsWith("http")){let{data:e}=(0,a.createClient)("https://mkrkkvbseobdqsalrorl.supabase.co",process.env.SUPABASE_SERVICE_ROLE_KEY,{db:{schema:"wacrm"}}).storage.from("chat-media").getPublicUrl(r);r=e.publicUrl}let t=await fetch(r);if(t.ok){let a=await t.arrayBuffer(),r=Buffer.from(a).toString("base64"),i=t.headers.get("content-type")||"image/jpeg";n.push({role:o?"user":"model",parts:[{text:e.content_text||"O que está nesta imagem?"},{inlineData:{mimeType:i,data:r}}]});continue}}catch(e){console.error("[AI Agent] Gemini failed to load image:",e)}n.push({role:o?"user":"model",parts:[{text:e.content_text||""}]})}let i=await fetch(t,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:n,systemInstruction:o?{parts:[{text:o}]}:void 0,generationConfig:{maxOutputTokens:1e3,temperature:.7}})});if(!i.ok){let e=await i.text();throw Error(`Gemini API error: ${i.status} - ${e}`)}let s=await i.json();return s?.candidates?.[0]?.content?.parts?.[0]?.text||""}async function l(e,o,r){let t=[];for(let e of(o&&t.push({role:"system",content:o}),r)){let o="customer"===e.sender_type;if("image"===e.content_type&&e.media_url){let r=e.media_url;if(!r.startsWith("http")){let{data:e}=(0,a.createClient)("https://mkrkkvbseobdqsalrorl.supabase.co",process.env.SUPABASE_SERVICE_ROLE_KEY,{db:{schema:"wacrm"}}).storage.from("chat-media").getPublicUrl(r);r=e.publicUrl}r.toLowerCase().includes(".webp")?t.push({role:o?"user":"assistant",content:e.content_text||"[Imagem enviada]"}):t.push({role:o?"user":"assistant",content:[{type:"text",text:e.content_text||"O que está nesta imagem?"},{type:"image_url",image_url:{url:r}}]})}else t.push({role:o?"user":"assistant",content:e.content_text||""})}let n=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${e}`},body:JSON.stringify({model:"gpt-4o-mini",messages:t,temperature:.7,max_tokens:1e3})});if(!n.ok){let e=await n.text();throw Error(`OpenAI API error: ${n.status} - ${e}`)}let i=await n.json();return i?.choices?.[0]?.message?.content||""}async function m(e,a,o){let r=[];for(let e of o){let a="customer"===e.sender_type;r.push({role:a?"user":"assistant",content:e.content_text||""})}let t=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":e,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-3-5-sonnet-20241022",max_tokens:1e3,system:a,messages:r})});if(!t.ok){let e=await t.text();throw Error(`Claude API error: ${t.status} - ${e}`)}let n=await t.json();return n?.content?.[0]?.text||""}async function u(e,a,o){let r=[];for(let e of(a&&r.push({role:"system",content:a}),o)){let a="customer"===e.sender_type;r.push({role:a?"user":"assistant",content:e.content_text||""})}let t=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${e}`,"HTTP-Referer":"https://wacrm.vercel.app","X-Title":"WA CRM"},body:JSON.stringify({model:"nousresearch/hermes-3-llama-3.1-405b",messages:r,temperature:.7,max_tokens:1e3})});if(!t.ok){let e=await t.text();throw Error(`Hermes OpenRouter API error: ${t.status} - ${e}`)}let n=await t.json();return n?.choices?.[0]?.message?.content||""}e.s(["handleAiAutoResponse",0,d])}];

//# sourceMappingURL=src_lib_ai_responder_ts_0a.2h29._.js.map