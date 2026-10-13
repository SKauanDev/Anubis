# Geo-Sleuth no ANUBIS

O painel usa o [Oldcircle/geo-sleuth](https://github.com/Oldcircle/geo-sleuth)
como uma dependência opcional. O código do skill não é copiado para o bundle do
ANUBIS; configure-o localmente:

```powershell
git clone https://github.com/Oldcircle/geo-sleuth.git tools/geo-sleuth
$env:GEO_SLEUTH_DIR = (Resolve-Path tools/geo-sleuth/skills/geo-sleuth).Path
$env:GEMINI_API_KEY = 'sua-chave-do-Google-AI-Studio'
uv run "$env:GEO_SLEUTH_DIR/scripts/doctor.py"
npm run dev
```

Para deixar a configuração persistente, coloque `GEO_SLEUTH_DIR` no `.env` do
projeto apontando para `tools/geo-sleuth/skills/geo-sleuth`. O painel executa o
`intake.py` no backend local, limita uploads a 25 MB e grava as execuções em
`.geo-sleuth-runs/` (ignorado pelo Git). A etapa multimodal usa `GEMINI_API_KEY`
e o modelo `gemini-3.5-flash-lite` por padrão; altere-o com
`GEMINI_GEO_SLEUTH_MODEL`.

## Real-ESRGAN opcional

O GEO-SLEUTH possui uma ponte opcional para o [Real-ESRGAN oficial](https://github.com/xinntao/Real-ESRGAN), usando o modelo geral `realesr-general-x4v3` antes do OCR. Ela não é ativada por padrão: em CPU, o modelo pode levar mais de três minutos e não recupera letras que já foram destruídas pelo desfoque.

Com uma GPU compatível e o checkout em `tools/Real-ESRGAN`, habilite apenas durante o teste:

```powershell
$env:GEO_SLEUTH_REALESRGAN = '1'
```

Sem GPU, mantenha essa variável desativada; o OCR local com contraste, nitidez e ampliação continua sendo usado automaticamente.
