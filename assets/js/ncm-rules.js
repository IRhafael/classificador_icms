// ════════════════════════════════════════════════════════════════════
// COERÊNCIA NCM × DESCRIÇÃO DO PRODUTO
// Cada categoria diz: "se a descrição parece X, o NCM deveria começar com Y".
// Quando o NCM informado não começa com nenhum dos prefixos esperados, o item
// é marcado como NCM SUSPEITO e entra na revisão por produto.
//
//   re      → padrão na descrição (já em MAIÚSCULAS e sem acento)
//   exceto  → padrão que cancela a categoria (evita falso positivo)
//   ncm     → prefixos aceitos (2, 4, 6 ou 8 dígitos)
//   sugerido→ NCM de 8 dígitos sugerido quando a correção é óbvia (opcional)
//
// Para incluir uma categoria nova, copie uma linha e ajuste. A ordem importa:
// a primeira categoria que casar com a descrição é a usada.
// ════════════════════════════════════════════════════════════════════
const NCM_CATEGORIAS = [
  // ── Medicamentos e saúde ────────────────────────────────────────────
  { id: 'medicamento', nome: 'Medicamento',
    re: /^MED\b\.?|MEDICAMENTO|DIPIRONA|PARACETAMOL|IBUPROFENO|NIMESULIDA|DORFLEX|SONRISAL|NEOSALDINA|BUSCOPAN|LEITE\s+(DE\s+)?MAGNESIA|AGUARDENTE\s+(NATURAL\s+)?ALEMA|AGUA\s+INGLESA/,
    ncm: ['3003', '3004'] },
  { id: 'curativo', nome: 'Curativo/atadura', re: /CURATIVO|BAND.?AID|ESPARADRAPO|\bGAZE\b|ATADURA/, ncm: ['3005', '3006'] },
  { id: 'preservativo', nome: 'Preservativo', re: /PRESERVATIVO|CAMISINHA|CONDOM/, ncm: ['40141'], sugerido: '40141000' },

  // ── Bebidas ─────────────────────────────────────────────────────────
  { id: 'agua-mineral', nome: 'Água mineral', re: /AGUA\s+MINERAL|AGUA\s+(C|S)\/?\s?GAS|AGUAFINA|AGUA\s+(DE\s+)?MESA/,
    exceto: /COCO|SANIT|OXIG|COL\b|COLONIA|MICELAR/, ncm: ['2201'], sugerido: '22011000' },
  { id: 'agua-coco', nome: 'Água de coco', re: /AGUA\s+(DE\s+)?COCO/,
    exceto: /^SAB\b|SABONETE|SHAMPOO|^SH\b|^COND\b|CONDICION|CREME|HIDRAT|\bHID\b|DESOD|LOCAO|PERFUM|COLONIA|OLEO|^DES\b/, ncm: ['200989', '2202'], sugerido: '20098921' },
  { id: 'refrigerante', nome: 'Refrigerante',
    re: /REFRIG|^COCA\b|COCA.?COLA|^CC\s|^CCOLA|^FANTA|^PEPSI|^SPRITE|^GUARANA\s|SODA\s+LIMONADA|H2OH|^SCHWEPPES/,
    exceto: /SODA\s+CAUST|ZERO\s+ALCOOL/, ncm: ['220210', '220299'], sugerido: '22021000' },
  { id: 'cerveja', nome: 'Cerveja', re: /^CERVEJA|^SKOL\b|^BRAHMA|^STELLA\s+ARTOIS|HEINEKEN|BUDWEISER|ITAIPAVA|^ANTARCTICA\s+SUB/,
    ncm: ['2203', '220291'], sugerido: '22030000' },
  { id: 'vinho', nome: 'Vinho/fermentado', re: /^VINHO\b|^SIDRA\b|ESPUMANTE/, ncm: ['2204', '2205', '2206'] },
  { id: 'destilado', nome: 'Bebida destilada', re: /^VODKA|^CACHACA|^AGUARDENTE|^CONHAQUE|^WHISK(E?Y)\b|^RUM\b|^GIN\b|^LICOR|^APER(ITIVO)?\b/,
    exceto: /ALEMA/, ncm: ['2208'] },
  { id: 'vinagre', nome: 'Vinagre', re: /^VINAGRE/, ncm: ['2209'], sugerido: '22090000' },
  { id: 'energetico', nome: 'Energético/isotônico', re: /ENERGETICO|RED\s*BULL|MONST(ER)?\s+ENERGY|GATORADE|POWERADE|ISOTONICO/,
    exceto: /ISQUEIRO|\bRACK\b|BONE|CAMIS|\bCOPO\b|CHAVEIRO|ADESIVO|SQUEEZE|GARRAFA\s+(TERM|PLAST)/, ncm: ['220299'], sugerido: '22029900' },

  // ── Leite e derivados ───────────────────────────────────────────────
  { id: 'leite-uht', nome: 'Leite UHT/longa vida', re: /LONG\.?\s*VIDA|LEITE\s+UHT/, exceto: /CREME|COND|COCO/, ncm: ['0401'] },
  { id: 'leite-po', nome: 'Leite em pó', re: /LEITE\s+(EM\s+)?PO\b|LEITE\s+INTEGRAL\s+INST|\bLEPO\b|^NINHO\b/,
    exceto: /FORMULA|NESTOGENO|INF\b|INFANTIL|\bNAN\b|APTAMIL|MILNUTRI|COMPOSTO|LT\s+INF|\bIOG|IOGURTE|POLPA|CEREAL|BISC/, ncm: ['0402'] },
  { id: 'leite-cond', nome: 'Leite condensado', re: /LEITE\s+COND/, exceto: /^CHOC|CHOCOLATE|COBERTURA|RECHEIO|^DOCE|BISC|^BOLO|SORVETE|SABOR|^BALA|^BOMBOM|^TRUFA|PICOLE/, ncm: ['040299'], sugerido: '04029900' },
  { id: 'creme-leite', nome: 'Creme de leite', re: /CREME\s+D?\s?E?\s*LEITE|CREME\s+LEITE/, ncm: ['0401', '0402'] },
  { id: 'iogurte', nome: 'Iogurte/leite fermentado', re: /\bIOG(URTE)?\b|LEITE\s+FERMENTADO/, exceto: /CHAMBINHO|PETIT\s+SUISSE|^HIDR|HIDRAT|^SAB\b|SABONETE|^SH\b|SHAMPOO|^COND\b|^CR\b|CREME\s+(P\/|DE\s+)?(PELE|MAOS|CORPO)/, ncm: ['0403', '2202'] },
  { id: 'queijo', nome: 'Queijo/requeijão', re: /^(QUEIJO|REQUEIJAO)\b/, ncm: ['0406'] },
  { id: 'manteiga', nome: 'Manteiga', re: /^MANTEIGA/, ncm: ['0405'], sugerido: '04051000' },
  { id: 'margarina', nome: 'Margarina', re: /^MARGARINA/, ncm: ['1517'], sugerido: '15171000' },
  { id: 'ovos', nome: 'Ovos', re: /^OVOS?\b/, ncm: ['0407'] },

  // ── Carnes e pescados ───────────────────────────────────────────────
  { id: 'bacon', nome: 'Bacon', re: /^BACON\b/, ncm: ['0210'], sugerido: '02101200' },
  { id: 'embutido', nome: 'Linguiça/salsicha/mortadela', re: /^LING(UICA)?\b|^SALSICHA|^MORTADELA/, ncm: ['1601', '1602'] },
  { id: 'presunto', nome: 'Presunto/apresuntado', re: /^PRESUNTO|^APRESUNTADO|^LANCHE\s+APRESUNT/, ncm: ['1602'] },
  { id: 'frango', nome: 'Carne de frango in natura',
    re: /^(FRANGO|GALINHA|PEITO\s+FRANG|FILE\s+(DE\s+)?PEITO|COXA|SOBRECOXA|ASAS?|COXINHA\s+(DA\s+)?ASA|CORTES\s+GALINHA|FIGADO\s+DE\s+FRAN|MOELA)\b/,
    exceto: /EMP\b|EMPAN|TEMP\.?\s*COZ|DESF|NUGGET|STEAK|SADIA\s+GRANEL/, ncm: ['0207', '0210', '1602'] },
  { id: 'bovino', nome: 'Carne bovina in natura',
    re: /\bBOV\b\.?|BOVINO|PICANHA|COXAO|CONTRA\s*FILE|ALCATRA|PATINHO|\bACEM\b|MUSCULO|CARNE\s+MOIDA|FRALDINHA/,
    exceto: /HAMBURG|FIAMBRE|ALMONDEGA|KIBE|EMPAN|AVE\/BOV|BOV\/FRANG|FAROFA|SABOR|TEMPERO|MOLHO|CHIPS|SALGAD|SNACK|BATATA|CALDO|SAZON|RACAO|PETISCO/, ncm: ['0201', '0202', '0206', '0210', '0504', '1602'] },
  { id: 'suino', nome: 'Carne suína in natura', re: /SUIN[OA]|BISTECA|\bLOMBO\b|PERNIL/, exceto: /LING|SALSICHA/,
    ncm: ['0203', '0206', '0209', '0210', '1601', '1602'] },
  { id: 'pescado', nome: 'Peixe', re: /TILAPIA|PANGA|PESCADA|MERLUZA|BACALHAU|SALMAO/, ncm: ['0302', '0303', '0304', '0305', '1604'] },
  { id: 'sardinha', nome: 'Sardinha/atum em conserva', re: /^(SARDINHA|ATUM)\b/, ncm: ['1604'] },

  // ── Mercearia ───────────────────────────────────────────────────────
  { id: 'arroz', nome: 'Arroz', re: /^ARROZ\b/, ncm: ['1006'] },
  { id: 'feijao', nome: 'Feijão', re: /^FEIJAO\b/, ncm: ['0713'] },
  { id: 'acucar', nome: 'Açúcar', re: /^ACUCAR\b/, ncm: ['1701'] },
  { id: 'cafe-soluvel', nome: 'Café solúvel', re: /^(CAFE|NESCAFE)\b.*\b(SOL|SOLUVEL|NESC)\b|^NESCAFE/, ncm: ['2101'], sugerido: '21011110' },
  { id: 'cafe', nome: 'Café torrado/moído', re: /^CAFE\b/, exceto: /CAPPUC|SOLUVEL|\bSOL\b|COADOR|BULE/, ncm: ['0901'], sugerido: '09012100' },
  { id: 'sal', nome: 'Sal de cozinha', re: /^SAL\s+(REFINADO|IOD|MOIDO|GROSSO|MARINHO|DE\s+COZINHA)\b/, ncm: ['2501'] },
  { id: 'oleo-soja', nome: 'Óleo de soja', re: /OLEO\s+(DE\s+)?SOJA/, ncm: ['1507'], sugerido: '15079011' },
  { id: 'oleo-vegetal', nome: 'Óleo vegetal comestível', re: /^OLEO\s+(DE\s+)?(MILHO|GIRASSOL|CANOLA|ALGODAO|COCO)\b/, ncm: ['15'] },
  { id: 'azeite-dende', nome: 'Azeite de dendê', re: /AZEITE\s+(DE\s+)?DENDE/, ncm: ['1511'], sugerido: '15119000' },
  { id: 'azeite', nome: 'Azeite de oliva', re: /^AZEITE\b/, ncm: ['1509', '1510'] },
  { id: 'macarrao', nome: 'Massa alimentícia',
    re: /^MAC(ARRAO|AR)?\b|ESPAGUETE|MASSA\s+(DE\s+)?SEMOLA|LASANHA\s+(MASSA|PRECOZ)|\bLAMEN\b|CUP\s+NOOD|MASSA\s+PARA\s+PASTEL/, ncm: ['1902'] },
  { id: 'farinha-trigo', nome: 'Farinha de trigo', re: /FARINHA\s+(DE\s+)?TRIGO/, ncm: ['1101'], sugerido: '11010010' },
  { id: 'farinha-mandioca', nome: 'Farinha de mandioca', re: /FARINHA\s+(DE\s+)?MAND/, ncm: ['110620', '1903'], sugerido: '11062000' },
  { id: 'amido-milho', nome: 'Amido de milho', re: /AMIDO\s+(DE\s+)?MILHO|^MAIZENA\s+AMIDO/, ncm: ['1108'], sugerido: '11081200' },
  { id: 'derivado-milho', nome: 'Fubá/flocão de milho', re: /^FUBA|FLOCAO\s+DE\s+MILHO|^FLOCUSCUZ|CUSCUZ\s+DE\s+MILHO|KIFLOCAO/,
    ncm: ['1102', '1103', '1104'] },
  { id: 'biscoito-polvilho', nome: 'Biscoito de polvilho', re: /\bPETA\b|BISC.*POV?L?VILHO|POV?L?VILHO.*BISC/, ncm: ['1905'], sugerido: '19059090' },
  { id: 'biscoito', nome: 'Biscoito/bolacha', re: /^BISC|BISCOITO|BOLACHA|^COOKIE|\bWAFER\b|CRACKER|^ROSQ/, ncm: ['1905'] },
  { id: 'pao', nome: 'Pão/torrada', re: /^PAO\b|^BISNAGUINHA|TORRADA/, exceto: /QUEIJO|\bQJO\b/, ncm: ['1905'] },
  { id: 'achocolatado-po', nome: 'Achocolatado em pó', re: /ACHOC(OLATADO)?\.?\s*(EM\s+)?PO\b|ACHOC\s+PO/, ncm: ['1806'], sugerido: '18069000' },
  { id: 'molho-tomate', nome: 'Extrato/molho de tomate', re: /EXTRATO\s+(DE\s+)?TOMATE|MOLHO\s+(DE\s+)?TOM(ATE)?\b|CATCHUP|KETCHUP/, ncm: ['2002', '2103'] },
  { id: 'maionese', nome: 'Maionese', re: /^MAIONESE/, ncm: ['210390'], sugerido: '21039011' },
  { id: 'torta-algodao', nome: 'Torta/farelo (ração)', re: /TORTA\s+DE\s+CAROCO|CAROCO\s+DE\s+ALGODAO/, ncm: ['2306'], sugerido: '23061000' },
  { id: 'farelo', nome: 'Farelo (ração)', re: /^FARELO\b/, ncm: ['2302', '2304', '2306', '2309', '1208'] },
  { id: 'racao', nome: 'Ração animal', re: /^RACAO|PEDIGREE|WHISKA|FRISKIES|^CHAMP\s+SACHE|^GOLDEN\s+(FORMULA|GATOS|CAES)/, ncm: ['2309'] },

  // ── Higiene e perfumaria ────────────────────────────────────────────
  { id: 'creme-dental', nome: 'Creme dental', re: /CREME\s+DENTAL|CRE\.?\s*DENT|^C\.\s*DENTAL|^CD\s+COLG|^CR\s+D\s/, ncm: ['330610'], sugerido: '33061000' },
  { id: 'escova-dental', nome: 'Escova dental', re: /ESC(OVA)?\.?\s*(DENT|COLG|SORR)|ESC\s+DENT/, ncm: ['960321'], sugerido: '96032100' },
  { id: 'fio-dental', nome: 'Fio dental', re: /FIO\s+D(EN)?T/, ncm: ['330620'], sugerido: '33062000' },
  { id: 'enxaguante', nome: 'Enxaguante bucal', re: /ENXAG|ANTISEP(TICO)?\s+(BUCAL|PLAX)|LISTERINE/, ncm: ['330690'], sugerido: '33069000' },
  { id: 'shampoo', nome: 'Shampoo/condicionador', re: /^SH\b\.?|SHAMPOO|^KIT\s+(SH|SEDA\s+SH)|^COND\b\.?|CONDICIONADOR|CR(EME)?\s+(DE\s+)?PENT/, ncm: ['3305'] },
  { id: 'sabonete', nome: 'Sabonete', re: /^SAB\b\.?(?!\s*(EM\s+)?(PO|PASTA)\b)|SABONETE(?!IRA)/, ncm: ['3401'] },
  { id: 'sabao', nome: 'Sabão/detergente', re: /^SABAO\b|^DET(ERG)?\b\.?|DETERGENTE|LAVA\s+ROU/, ncm: ['3401', '3402'] },
  { id: 'amaciante', nome: 'Amaciante', re: /^AMAC/, exceto: /CARNE|TEMPERO/, ncm: ['3809', '3402'] },
  { id: 'desinfetante', nome: 'Desinfetante', re: /^DESE?INF/, ncm: ['3808', '3402'] },
  { id: 'agua-sanitaria', nome: 'Água sanitária', re: /AGUA\s+SANIT/, ncm: ['2828'], sugerido: '28289011' },
  { id: 'desodorante', nome: 'Desodorante', re: /^DES(OD)?\b\.?\s|^DES\.|DESODORANTE|ANTITRANSP|^DS\.|^DEO\b/, exceto: /SANIT|LIQ\.?\s+P\/?\s*PISO/, ncm: ['3307'] },
  { id: 'fralda-absorvente', nome: 'Fralda/absorvente', re: /^FRALD|^FDA\b|^FRD\b|^ABS\b\.?|ABSORVENTE/, ncm: ['9619'], sugerido: '96190000' },
  { id: 'barbear', nome: 'Aparelho/lâmina de barbear',
    re: /^AP(AR)?\.?\s*BARB|APARELHO\s+(DE\s+)?BARBEAR|PRESTOBARBA|GILLETTE|^LAMINA\b|^APAR\.?\s*BIC|SHAVER/, ncm: ['8212'], sugerido: '82121020' },
  { id: 'esmalte', nome: 'Esmalte', re: /^ESM(ALTE)?\b/, ncm: ['330430'], sugerido: '33043000' },
  { id: 'protetor-solar', nome: 'Protetor solar', re: /PROT(ETOR)?\.?\s*SOLAR|^P\.\s*SOLAR/, ncm: ['3304'], sugerido: '33049990' },
  { id: 'cotonete', nome: 'Hastes flexíveis', re: /COTONETE|HASTES?\s+FLEX/, ncm: ['560121', '5601'], sugerido: '56012190' },
  { id: 'papel-higienico', nome: 'Papel higiênico', re: /PAPEL\s+HIG|PPL\.?\s*HIG/, ncm: ['481810'], sugerido: '48181000' },
  { id: 'papel-toalha', nome: 'Papel toalha/guardanapo', re: /PAPEL\s+TOALHA|^GUARD(ANAPO)?\b/, ncm: ['4818'] },

  // ── Utilidades, elétricos, limpeza ──────────────────────────────────
  { id: 'lampada', nome: 'Lâmpada', re: /^LAMP(ADA)?\b/, ncm: ['8539'] },
  { id: 'pilha', nome: 'Pilha/bateria', re: /^PILHA|^BATERIA\s/, ncm: ['8506', '8507'] },
  { id: 'extensao', nome: 'Extensão elétrica', re: /^EXTENSAO/, ncm: ['8544'], sugerido: '85444200' },
  { id: 'inseticida', nome: 'Inseticida', re: /^INSET|CUPINICIDA|MATA\s+BARATA/, ncm: ['3808'] },
  { id: 'vela', nome: 'Vela', re: /^VELA\b/, exceto: /POLVORA|FILTRO/, ncm: ['3406'], sugerido: '34060000' },
  { id: 'fosforo', nome: 'Fósforo', re: /^FOSFORO/, ncm: ['3605'], sugerido: '36050000' },
  { id: 'cigarro', nome: 'Cigarro', re: /^CIGARRO|^KENT\b|^ROTHMANS|MARLBORO|^DERBY|LUCKY\s+STRIKE/, ncm: ['2402'], sugerido: '24022000' },
  { id: 'alcool', nome: 'Álcool', re: /^ALCOOL\b/, ncm: ['2207', '3808'] },
  { id: 'peroba', nome: 'Óleo de peroba/lustra-móveis', re: /PEROBA|LUSTRA\s*-?\s*MOV/, ncm: ['3405'], sugerido: '34052000' },
  { id: 'lubrificante', nome: 'Óleo lubrificante', re: /OLEO\s+LUB|LUBRIFICANTE|MOTOR\s+OIL|\b20W50\b|\b[24]T\b.*OLEO/, ncm: ['2710', '3403'] },
  { id: 'papel-aluminio', nome: 'Papel alumínio', re: /PAPEL\s+ALUMINIO/, ncm: ['7607'] },
  { id: 'la-aco', nome: 'Esponja/lã de aço', re: /\bLA\s+(DE\s+)?ACO|ESPONJA\s+(DE\s+)?(LA\s+)?ACO|BOMBRIL/, ncm: ['732310'], sugerido: '73231000' },
  { id: 'saco-lixo', nome: 'Saco de lixo', re: /SACO\s+(DE\s+)?LIXO/, ncm: ['3923'] },
  { id: 'mostardeira', nome: 'Utensílio de mesa/cozinha (plástico)', re: /MOSTARDEIRA|CATCHUPEIRA|GALHETEIRO|PORTA\s+OLEO|SALEIRO|^BALDE\b|^BACIA\b/,
    ncm: ['3924', '3926', '7013', '7323', '7615', '6911', '6912'], sugerido: '39241000' },
  { id: 'vaso', nome: 'Vaso', re: /^VASO\b/, ncm: ['3924', '3926', '6910', '6912', '6913', '6914', '7013', '6810'] },
  { id: 'peneira', nome: 'Peneira', re: /^PENEIRA/, ncm: ['9604', '7323', '3924', '7326', '4602'], sugerido: '96040000' },
  { id: 'panela', nome: 'Panela/utensílio de cozinha', re: /^PANELA|^PAN\.?\s*PR|CUSCUZEIR|FRIGIDEIRA|CACAROLA|CALDEIRAO|FERVEDOR/, ncm: ['7615', '7323', '7321'] },
  { id: 'calcado', nome: 'Calçado/chinelo', re: /^CHINELO|^SAND(ALIA)?\b|HAVAIANA|^BOTINA|^BOTA\b/, ncm: ['6401', '6402', '6403', '6404', '6405'] },
  { id: 'brinquedo', nome: 'Brinquedo', re: /^BRINQ|BRINQUEDO|^BONECA/, ncm: ['9503'] },
  { id: 'caderno', nome: 'Caderno', re: /^CAD(ERNO)?\b\.?|^CADERNETA/, ncm: ['4820'] },
  { id: 'caneta-lapis', nome: 'Caneta/lápis', re: /^CANETA|^LAPIS\b|^LAPISEIRA/, ncm: ['9608', '9609'] },
];

// ── Checagem inversa ────────────────────────────────────────────────
// Posições sensíveis (normalmente ST) que só devem aparecer quando a
// descrição confirma o tipo de produto. Usada quando nenhuma categoria acima
// reconheceu a descrição.
const NCM_EXIGE_DESCRICAO = [
  { prefixos: ['3003', '3004'], nome: 'Medicamento',
    re: /^MED\b|MEDIC|GOTAS|\bGTS\b|\bCOMP\b|COMPRIMIDO|XAROPE|POMADA|CAPSULA|\d\s*MG\b|\bSUSP\b|AMPOLA|EFERV|VITAMINA|PASTILHA|ANTIAC|ANALG|ANTI[- ]?(GRIPAL|INFLAM|SEPT)|SORO\b|COLIRIO|\bINJ\b|INJET|\bVET\b|VETERIN|VERMIF|PARASIT|IVOMEC|\bSPRAY\b/ },
];

if (typeof module !== 'undefined') module.exports = { NCM_CATEGORIAS, NCM_EXIGE_DESCRICAO };
