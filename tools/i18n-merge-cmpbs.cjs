// P2 多语补全（2026-09-24）：compare-betterstack.html 专属键 cmpbs.* + 共用 footer.compareUr
// 用法：node tools/i18n-merge-cmpbs.cjs  → 合并进 public/i18n/{en,zh,es,pt,de,fr,ja,ko}.json
// 规则：键必须 8 语齐全才写入；已存在的键不覆盖（幂等）；写回保持 2 空格缩进 + 尾换行。
'use strict';
const fs = require('fs');
const path = require('path');
const LANGS = ['en', 'zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko'];

const M = {
  'footer.compareUr': {
    en: 'vs UptimeRobot', zh: '对比 UptimeRobot', es: 'vs UptimeRobot', pt: 'vs UptimeRobot',
    de: 'vs UptimeRobot', fr: 'vs UptimeRobot', ja: 'UptimeRobot比較', ko: 'UptimeRobot 비교'
  },
  'cmpbs.meta.title': {
    en: 'Pingory vs Better Stack 2026: Price, Simplicity & Honest Verdict',
    zh: 'Pingory 与 Better Stack 2026 对比：价格、简洁度与客观结论',
    es: 'Pingory vs Better Stack 2026: precio, simplicidad y veredicto honesto',
    pt: 'Pingory vs Better Stack 2026: preço, simplicidade e veredito honesto',
    de: 'Pingory vs. Better Stack 2026: Preis, Einfachheit und ehrliches Fazit',
    fr: 'Pingory vs Better Stack 2026 : prix, simplicité et verdict honnête',
    ja: 'Pingory vs Better Stack 2026：価格・シンプルさ・正直な評価',
    ko: 'Pingory vs Better Stack 2026: 가격, 간편함, 솔직한 평가'
  },
  'cmpbs.meta.desc': {
    en: 'Pingory vs Better Stack 2026: an honest Better Stack alternative comparison — free plans, pricing per monitor, status pages, on-call features, and where Better Stack still wins.',
    zh: 'Pingory 与 Better Stack 2026 对比：客观的 Better Stack 替代品分析——免费档、单监控价格、状态页、值班功能，以及 Better Stack 仍然更强的地方。',
    es: 'Pingory vs Better Stack 2026: una comparación honesta de alternativas a Better Stack — planes gratuitos, precio por monitor, páginas de estado, funciones de guardia y dónde sigue ganando Better Stack.',
    pt: 'Pingory vs Better Stack 2026: uma comparação honesta de alternativas ao Better Stack — planos gratuitos, preço por monitor, páginas de status, recursos de plantão e onde o Better Stack ainda vence.',
    de: 'Pingory vs. Better Stack 2026: ein ehrlicher Vergleich mit Better-Stack-Alternativen — kostenlose Pläne, Preis pro Monitor, Statusseiten, On-Call-Funktionen und wo Better Stack weiterhin gewinnt.',
    fr: "Pingory vs Better Stack 2026 : une comparaison honnête des alternatives à Better Stack — offres gratuites, prix par moniteur, pages de statut, fonctions d'astreinte et là où Better Stack gagne encore.",
    ja: 'Pingory vs Better Stack 2026：Better Stack の代替を正直に比較——無料プラン、モニター単位の価格、ステータスページ、オンコール機能、そして Better Stack がまだ勝っている点。',
    ko: 'Pingory vs Better Stack 2026: Better Stack 대안에 대한 솔직한 비교 — 무료 플랜, 모니터당 가격, 상태 페이지, 온콜 기능, 그리고 Better Stack이 여전히 앞선 부분.'
  },
  'cmpbs.h1': {
    en: 'Pingory vs Better Stack (2026): An Honest Comparison',
    zh: 'Pingory 与 Better Stack（2026）对比：客观评测',
    es: 'Pingory vs Better Stack (2026): una comparación honesta',
    pt: 'Pingory vs Better Stack (2026): uma comparação honesta',
    de: 'Pingory vs. Better Stack (2026): Ein ehrlicher Vergleich',
    fr: 'Pingory vs Better Stack (2026) : une comparaison honnête',
    ja: 'Pingory vs Better Stack（2026）：正直な比較',
    ko: 'Pingory vs Better Stack (2026): 솔직한 비교'
  },
  'cmpbs.ogdesc': {
    en: 'Pingory vs Better Stack 2026: pricing per monitor, status pages, on-call and log management compared — including where Better Stack still wins.',
    zh: 'Pingory 与 Better Stack 2026 对比：单监控价格、状态页、值班与日志管理——以及 Better Stack 仍然更强的地方。',
    es: 'Pingory vs Better Stack 2026: comparación de precio por monitor, páginas de estado, guardias y gestión de registros — incluyendo dónde sigue ganando Better Stack.',
    pt: 'Pingory vs Better Stack 2026: comparação de preço por monitor, páginas de status, plantão e gestão de logs — incluindo onde o Better Stack ainda vence.',
    de: 'Pingory vs. Better Stack 2026: Preis pro Monitor, Statusseiten, On-Call und Log-Management im Vergleich — inklusive der Punkte, wo Better Stack weiterhin gewinnt.',
    fr: 'Pingory vs Better Stack 2026 : prix par moniteur, pages de statut, astreinte et gestion de logs comparés — y compris là où Better Stack gagne encore.',
    ja: 'Pingory vs Better Stack 2026：モニター単位の価格、ステータスページ、オンコール、ログ管理を比較——Better Stack がまだ勝っている点も含めて。',
    ko: 'Pingory vs Better Stack 2026: 모니터당 가격, 상태 페이지, 온콜, 로그 관리 비교 — Better Stack이 여전히 앞선 부분 포함.'
  },
  'cmpbs.lead': {
    en: 'If you are looking for a <strong>Better Stack alternative</strong>, you already know the product: Better Stack (formerly Better Uptime) is one of the most polished monitoring suites on the market, bundling uptime checks with <strong>incident management, on-call scheduling, and log management</strong>. This page compares Pingory and Better Stack on the numbers that show up on an invoice — price, monitor limits, check intervals, and <strong>status pages</strong> — and says plainly where Better Stack still wins.',
    zh: '如果你在找 <strong>Better Stack 的替代品</strong>，你应该已经认识这个产品：Better Stack（原名 Better Uptime）是市面上打磨得最精细的监控套件之一，把可用性检查与<strong>事件管理、值班排班和日志管理</strong>打包在一起。本页把 Pingory 和 Better Stack 放在一起比「真正会出现在账单上」的指标——价格、监控数量上限、检查间隔和<strong>状态页</strong>——Better Stack 仍然更强的地方，我们也会直说。',
    es: 'Si buscas una <strong>alternativa a Better Stack</strong>, ya conoces el producto: Better Stack (antes Better Uptime) es una de las suites de monitorización más pulidas del mercado, que combina comprobaciones de disponibilidad con <strong>gestión de incidentes, programación de guardias y gestión de registros</strong>. Esta página compara Pingory y Better Stack en las cifras que aparecen en la factura — precio, límites de monitores, intervalos de comprobación y <strong>páginas de estado</strong> — y dice con claridad dónde sigue ganando Better Stack.',
    pt: 'Se você procura uma <strong>alternativa ao Better Stack</strong>, já conhece o produto: o Better Stack (antigo Better Uptime) é uma das suítes de monitoramento mais bem acabadas do mercado, combinando verificações de disponibilidade com <strong>gestão de incidentes, escalas de plantão e gestão de logs</strong>. Esta página compara Pingory e Better Stack nos números que aparecem na fatura — preço, limites de monitores, intervalos de verificação e <strong>páginas de status</strong> — e diz com clareza onde o Better Stack ainda vence.',
    de: 'Wenn du eine <strong>Better-Stack-Alternative</strong> suchst, kennst das Produkt bereits: Better Stack (früher Better Uptime) ist eine der ausgereiftesten Monitoring-Suiten am Markt und bündelt Uptime-Prüfungen mit <strong>Incident-Management, On-Call-Planung und Log-Management</strong>. Diese Seite vergleicht Pingory und Better Stack anhand der Zahlen, die auf der Rechnung landen — Preis, Monitor-Limits, Prüfintervalle und <strong>Statusseiten</strong> — und sagt offen, wo Better Stack weiterhin gewinnt.',
    fr: "Si vous cherchez une <strong>alternative à Better Stack</strong>, vous connaissez déjà le produit : Better Stack (anciennement Better Uptime) est l'une des suites de supervision les plus abouties du marché, associant contrôles de disponibilité et <strong>gestion des incidents, planification d'astreinte et gestion des logs</strong>. Cette page compare Pingory et Better Stack sur les chiffres qui apparaissent sur la facture — prix, limites de moniteurs, intervalles de contrôle et <strong>pages de statut</strong> — et dit clairement où Better Stack gagne encore.",
    ja: '<strong>Better Stack の代替</strong>をお探しなら、製品自体はご存じでしょう：Better Stack（旧 Better Uptime）は市場で最も洗練された監視スイートの一つで、稼働監視に<strong>インシデント管理・オンコール設定・ログ管理</strong>をバンドルしています。このページでは、Pingory と Better Stack を「請求書に実際に載る数字」——価格、モニター上限、チェック間隔、<strong>ステータスページ</strong>——で比較し、Better Stack がまだ勝っている点も率直に示します。',
    ko: '<strong>Better Stack 대안</strong>을 찾고 계시다면 제품은 이미 아실 겁니다: Better Stack(구 Better Uptime)은 시장에서 가장 세련된 모니터링 스위트 중 하나로, 업타임 점검에 <strong>인시던트 관리, 온콜 일정, 로그 관리</strong>를 번들로 제공합니다. 이 페이지는 Pingory와 Better Stack을 청구서에 실제로 나타나는 숫자들 — 가격, 모니터 한도, 점검 간격, <strong>상태 페이지</strong> — 로 비교하고, Better Stack이 여전히 앞선 부분도 솔직하게 말씀드립니다.'
  },
  'cmpbs.short.1': {
    en: "Better Stack's free tier: <strong>10 monitors at 3-minute checks</strong> plus 1 status page. Pingory's free tier: <strong>50 monitors at 5-minute checks</strong>. Neither requires a credit card.",
    zh: 'Better Stack 免费档：<strong>10 个监控、3 分钟检查</strong>，外加 1 个状态页。Pingory 免费档：<strong>50 个监控、5 分钟检查</strong>。两者都不需要信用卡。',
    es: 'Nivel gratuito de Better Stack: <strong>10 monitores con comprobaciones cada 3 minutos</strong> más 1 página de estado. Nivel gratuito de Pingory: <strong>50 monitores con comprobaciones cada 5 minutos</strong>. Ninguno requiere tarjeta de crédito.',
    pt: 'Plano gratuito do Better Stack: <strong>10 monitores com verificações a cada 3 minutos</strong> mais 1 página de status. Plano gratuito da Pingory: <strong>50 monitores com verificações a cada 5 minutos</strong>. Nenhum exige cartão de crédito.',
    de: 'Better-Stack-Kostenlosversion: <strong>10 Monitore mit 3-Minuten-Prüfungen</strong> plus 1 Statusseite. Pingory-Kostenlosversion: <strong>50 Monitore mit 5-Minuten-Prüfungen</strong>. Keiner davon erfordert eine Kreditkarte.',
    fr: 'Offre gratuite de Better Stack : <strong>10 moniteurs avec des contrôles toutes les 3 minutes</strong> plus 1 page de statut. Offre gratuite de Pingory : <strong>50 moniteurs avec des contrôles toutes les 5 minutes</strong>. Aucune des deux ne demande de carte bancaire.',
    ja: 'Better Stack の無料プラン：<strong>3分間隔のチェックでモニター 10</strong> とステータスページ 1。Pingory の無料プラン：<strong>5分間隔のチェックでモニター 50</strong>。どちらもクレジットカード不要です。',
    ko: 'Better Stack 무료 플랜: <strong>3분 주기 점검 모니터 10개</strong> + 상태 페이지 1개. Pingory 무료 플랜: <strong>5분 주기 점검 모니터 50개</strong>. 어느 쪽도 신용카드가 필요하지 않습니다.'
  },
  'cmpbs.short.2': {
    en: "Pingory's paid plans start at <strong>$4/month for 100 monitors with 60-second checks</strong>. Better Stack's responder license starts around <strong>$29/month (annual billing)</strong>, and 50 additional uptime monitors cost <strong>$21/month on top</strong>.",
    zh: 'Pingory 付费档从 <strong>$4/月（100 个监控、60 秒检查）</strong>起。Better Stack 的 Responder 许可证约 <strong>$29/月（年付）</strong>起，追加 50 个可用性监控还要<strong>另付 $21/月</strong>。',
    es: 'Los planes de pago de Pingory empiezan en <strong>$4/mes por 100 monitores con comprobaciones de 60 segundos</strong>. La licencia responder de Better Stack empieza en unos <strong>$29/mes (facturación anual)</strong>, y 50 monitores de disponibilidad adicionales cuestan <strong>$21/mes más</strong>.',
    pt: 'Os planos pagos da Pingory começam em <strong>$4/mês por 100 monitores com verificações de 60 segundos</strong>. A licença responder do Better Stack começa em cerca de <strong>$29/mês (cobrança anual)</strong>, e 50 monitores de disponibilidade adicionais custam <strong>$21/mês a mais</strong>.',
    de: 'Die kostenpflichtigen Pingory-Pläne beginnen bei <strong>4 $/Monat für 100 Monitore mit 60-Sekunden-Prüfungen</strong>. Die Responder-Lizenz von Better Stack kostet etwa <strong>29 $/Monat (Jahresabrechnung)</strong>, und 50 zusätzliche Uptime-Monitore kosten <strong>21 $/Monat extra</strong>.',
    fr: 'Les offres payantes de Pingory démarrent à <strong>4 $/mois pour 100 moniteurs avec des contrôles toutes les 60 secondes</strong>. La licence responder de Better Stack démarre à environ <strong>29 $/mois (facturation annuelle)</strong>, et 50 moniteurs de disponibilité supplémentaires coûtent <strong>21 $/mois de plus</strong>.',
    ja: 'Pingory の有料プランは<strong>月額 $4（モニター 100、60秒間隔のチェック）</strong>から。Better Stack の responder ライセンスは<strong>月額約 $29（年払い）</strong>からで、稼働監視モニター 50 追加には<strong>さらに月額 $21</strong> かかります。',
    ko: 'Pingory 유료 플랜은 <strong>월 $4(모니터 100개, 60초 점검)</strong>부터 시작합니다. Better Stack의 responder 라이선스는 <strong>월 약 $29(연간 결제)</strong>부터이며, 업타임 모니터 50개 추가 시 <strong>월 $21</strong>가 추가됩니다.'
  },
  'cmpbs.short.3': {
    en: "At <strong>$6/month</strong>, Pingory gives you <strong>unlimited monitors and 30-second checks</strong>. Better Stack's 30-second checks sit on its paid tiers.",
    zh: '$6/月的 Pingory 给你<strong>不限监控数 + 30 秒检查</strong>。Better Stack 的 30 秒检查只在付费档提供。',
    es: 'Por <strong>$6/mes</strong>, Pingory te da <strong>monitores ilimitados y comprobaciones de 30 segundos</strong>. Las comprobaciones de 30 segundos de Better Stack están en sus planes de pago.',
    pt: 'Por <strong>$6/mês</strong>, a Pingory oferece <strong>monitores ilimitados e verificações de 30 segundos</strong>. As verificações de 30 segundos do Better Stack estão nos planos pagos.',
    de: 'Für <strong>6 $/Monat</strong> bietet dir Pingory <strong>unbegrenzte Monitore und 30-Sekunden-Prüfungen</strong>. Better Stack bietet 30-Sekunden-Prüfungen erst in kostenpflichtigen Stufen.',
    fr: 'Pour <strong>6 $/mois</strong>, Pingory vous donne <strong>des moniteurs illimités et des contrôles toutes les 30 secondes</strong>. Les contrôles de 30 secondes de Better Stack sont réservés à ses offres payantes.',
    ja: '<strong>月額 $6</strong> の Pingory なら<strong>モニター無制限・30秒間隔のチェック</strong>。Better Stack の 30 秒チェックは有料プランに限られます。',
    ko: '<strong>월 $6</strong>이면 Pingory에서 <strong>무제한 모니터와 30초 점검</strong>을 제공합니다. Better Stack의 30초 점검은 유료 플랜에만 있습니다.'
  },
  'cmpbs.short.4': {
    en: 'Better Stack wins on <strong>incident management, on-call rotations with phone and SMS alerts, bundled log management, and a beautiful UI</strong>.',
    zh: 'Better Stack 在<strong>事件管理、带电话/短信告警的值班轮换、打包的日志管理，以及精美的界面</strong>上更强。',
    es: 'Better Stack gana en <strong>gestión de incidentes, rotaciones de guardia con alertas telefónicas y SMS, gestión de registros integrada y una interfaz hermosa</strong>.',
    pt: 'O Better Stack vence em <strong>gestão de incidentes, rotações de plantão com alertas por telefone e SMS, gestão de logs integrada e uma interface bonita</strong>.',
    de: 'Better Stack gewinnt bei <strong>Incident-Management, On-Call-Diensten mit Telefon- und SMS-Alarmen, integriertem Log-Management und einer schönen Oberfläche</strong>.',
    fr: "Better Stack gagne sur <strong>la gestion des incidents, les rotations d'astreinte avec alertes téléphoniques et SMS, la gestion de logs intégrée et une belle interface</strong>.",
    ja: 'Better Stack が勝るのは<strong>インシデント管理、電話・SMS アラート対応のオンコールローテーション、バンドルされたログ管理、美しい UI</strong> です。',
    ko: 'Better Stack은 <strong>인시던트 관리, 전화·SMS 알림이 포함된 온콜 로테이션, 번들 로그 관리, 아름다운 UI</strong>에서 앞섭니다.'
  },
  'cmpbs.short.5': {
    en: 'Pingory wins on <strong>price per monitor, status page economics, simplicity, 8 UI languages, and open source code (AGPL-3.0) you can self-host</strong>.',
    zh: 'Pingory 在<strong>单监控价格、状态页性价比、简洁性、8 种界面语言，以及可自托管的开源代码（AGPL-3.0）</strong>上更强。',
    es: 'Pingory gana en <strong>precio por monitor, economía de las páginas de estado, simplicidad, 8 idiomas de interfaz y código abierto (AGPL-3.0) que puedes autoalojar</strong>.',
    pt: 'A Pingory vence em <strong>preço por monitor, custo-benefício das páginas de status, simplicidade, 8 idiomas de interface e código aberto (AGPL-3.0) que você pode auto-hospedar</strong>.',
    de: 'Pingory gewinnt bei <strong>Preis pro Monitor, Statusseiten-Kosten, Einfachheit, 8 Oberflächensprachen und selbst hostbarem Open-Source-Code (AGPL-3.0)</strong>.',
    fr: "Pingory gagne sur <strong>le prix par moniteur, le rapport qualité-prix des pages de statut, la simplicité, 8 langues d'interface et un code open source (AGPL-3.0) que vous pouvez auto-héberger</strong>.",
    ja: 'Pingory が勝るのは<strong>モニター単位の価格、ステータスページのコスパ、シンプルさ、8 言語の UI、そしてセルフホスト可能なオープンソースコード（AGPL-3.0）</strong>です。',
    ko: 'Pingory는 <strong>모니터당 가격, 상태 페이지 가성비, 간편함, 8개 UI 언어, 그리고 셀프호스팅 가능한 오픈소스 코드(AGPL-3.0)</strong>에서 앞섭니다.'
  },
  'cmpbs.price.note': {
    en: "Prices below are as published in September 2026. Better Stack discounts annual billing and sells add-ons separately; verify current figures on each vendor's site before you buy.",
    zh: '以下为 2026 年 9 月各官网公布的价格。Better Stack 对年付有折扣、附加功能单独售卖；购买前请以各家官网现价为准。',
    es: 'Los precios siguientes son los publicados en septiembre de 2026. Better Stack descuenta la facturación anual y vende complementos por separado; verifica las cifras actuales en el sitio de cada proveedor antes de comprar.',
    pt: 'Os preços abaixo são os publicados em setembro de 2026. O Better Stack dá desconto na cobrança anual e vende complementos separadamente; verifique os valores atuais no site de cada fornecedor antes de comprar.',
    de: 'Die folgenden Preise entsprechen der Veröffentlichung von September 2026. Better Stack vergünstigt die Jahresabrechnung und verkauft Zusatzfunktionen separat; prüfe die aktuellen Zahlen vor dem Kauf auf der jeweiligen Anbieterseite.',
    fr: "Les prix ci-dessous sont ceux publiés en septembre 2026. Better Stack accorde une remise annuelle et vend les add-ons séparément ; vérifiez les chiffres actuels sur le site de chaque fournisseur avant d'acheter.",
    ja: '以下の価格は 2026 年 9 月時点の公表値です。Better Stack は年払い割引があり、アドオンは別売りです。購入前に各社サイトで最新の数値をご確認ください。',
    ko: '아래 가격은 2026년 9월 기준 공개 가격입니다. Better Stack은 연간 결제 할인을 제공하며 애드온은 별도 판매합니다. 구매 전 각 업체 사이트에서 최신 가격을 확인하세요.'
  },
  'cmpbs.v.r1.u': {
    en: '$0 — 10 monitors, 3-minute checks, 1 status page',
    zh: '$0 — 10 个监控，3 分钟检查，1 个状态页',
    es: '$0 — 10 monitores, comprobaciones cada 3 minutos, 1 página de estado',
    pt: '$0 — 10 monitores, verificações a cada 3 minutos, 1 página de status',
    de: '0 $ — 10 Monitore, 3-Minuten-Prüfungen, 1 Statusseite',
    fr: '0 $ — 10 moniteurs, contrôles toutes les 3 minutes, 1 page de statut',
    ja: '$0 — モニター 10、3分間隔のチェック、ステータスページ 1',
    ko: '$0 — 모니터 10개, 3분 주기 점검, 상태 페이지 1개'
  },
  'cmpbs.v.r2.u': {
    en: 'Responder license — ~$29/mo annual ($34 monthly)',
    zh: 'Responder 许可证 — 年付约 $29/月（月付 $34）',
    es: 'Licencia responder — ~$29/mes anual ($34 mensual)',
    pt: 'Licença responder — ~$29/mês anual ($34 mensal)',
    de: 'Responder-Lizenz — ca. 29 $/Monat jährlich (34 $ monatlich)',
    fr: 'Licence responder — ~29 $/mois en annuel (34 $ mensuel)',
    ja: 'Responder ライセンス — 年払い 約 $29/月（月払い $34）',
    ko: 'Responder 라이선스 — 연 결제 약 $29/월 (월 결제 $34)'
  },
  'cmpbs.v.r3.p': {
    en: '100 monitors, 60-second checks',
    zh: '100 个监控，60 秒检查',
    es: '100 monitores, comprobaciones de 60 segundos',
    pt: '100 monitores, verificações de 60 segundos',
    de: '100 Monitore, 60-Sekunden-Prüfungen',
    fr: '100 moniteurs, contrôles toutes les 60 secondes',
    ja: 'モニター 100、60秒間隔のチェック',
    ko: '모니터 100개, 60초 점검'
  },
  'cmpbs.v.r3.u': {
    en: '10 monitors included; 50 more cost $21/mo extra',
    zh: '含 10 个监控；追加 50 个需另付 $21/月',
    es: '10 monitores incluidos; 50 más cuestan $21/mes extra',
    pt: '10 monitores incluídos; 50 mais custam $21/mês extra',
    de: '10 Monitore enthalten; 50 weitere kosten 21 $/Monat extra',
    fr: '10 moniteurs inclus ; 50 de plus coûtent 21 $/mois en supplément',
    ja: 'モニター 10 付き。追加 50 は月額 $21 増し',
    ko: '모니터 10개 포함; 50개 추가 시 월 $21 추가'
  },
  'cmpbs.r4.h': {
    en: 'Top self-serve plan',
    zh: '最高的自助档',
    es: 'Plan de autoservicio más alto',
    pt: 'Plano de autoatendimento mais alto',
    de: 'Höchster Self-Service-Plan',
    fr: 'Offre en libre-service la plus haute',
    ja: '最上位のセルフサーブプラン',
    ko: '최상위 셀프서브 플랜'
  },
  'cmpbs.v.r4.p': {
    en: 'Pro — $6/mo, unlimited monitors',
    zh: 'Pro — $6/月，监控数不限',
    es: 'Pro — $6/mes, monitores ilimitados',
    pt: 'Pro — $6/mês, monitores ilimitados',
    de: 'Pro — 6 $/Monat, unbegrenzte Monitore',
    fr: 'Pro — 6 $/mois, moniteurs illimités',
    ja: 'Pro — 月額 $6、モニター無制限',
    ko: 'Pro — 월 $6, 무제한 모니터'
  },
  'cmpbs.v.r4.u': {
    en: 'Team/Responder tiers with per-seat licenses + usage-based add-ons',
    zh: 'Team/Responder 档按席位计费 + 按用量加购',
    es: 'Niveles Team/Responder con licencias por puesto + complementos por uso',
    pt: 'Níveis Team/Responder com licenças por assento + complementos por uso',
    de: 'Team-/Responder-Stufen mit Pro-Sitz-Lizenzen + nutzungsbasierten Zusätzen',
    fr: "Paliers Team/Responder avec licences par siège + add-ons à l'usage",
    ja: 'Team/Responder は 1 シート単位のライセンス + 従量制アドオン',
    ko: 'Team/Responder 등급은 좌석당 라이선스 + 사용량 기반 애드온'
  },
  'cmpbs.r5.h': {
    en: 'Fastest check interval',
    zh: '最快检查间隔',
    es: 'Intervalo de comprobación más rápido',
    pt: 'Intervalo de verificação mais rápido',
    de: 'Schnellstes Prüfintervall',
    fr: 'Intervalle de contrôle le plus rapide',
    ja: '最短チェック間隔',
    ko: '가장 빠른 점검 간격'
  },
  'cmpbs.v.r5.p': {
    en: '30 seconds at $6/mo',
    zh: '$6/月档为 30 秒',
    es: '30 segundos por $6/mes',
    pt: '30 segundos por $6/mês',
    de: '30 Sekunden für 6 $/Monat',
    fr: '30 secondes à 6 $/mois',
    ja: '月額 $6 で 30 秒',
    ko: '월 $6에 30초'
  },
  'cmpbs.v.r5.u': {
    en: '30 seconds on premium tiers',
    zh: '30 秒仅限更高档位',
    es: '30 segundos en niveles premium',
    pt: '30 segundos nos níveis premium',
    de: '30 Sekunden in Premium-Stufen',
    fr: '30 secondes sur les paliers premium',
    ja: '30 秒は上位プランで',
    ko: '30초는 프리미엄 등급에서'
  },
  'cmpbs.r6.h': {
    en: 'Public status page',
    zh: '公开状态页',
    es: 'Página de estado pública',
    pt: 'Página de status pública',
    de: 'Öffentliche Statusseite',
    fr: 'Page de statut publique',
    ja: '公開ステータスページ',
    ko: '공개 상태 페이지'
  },
  'cmpbs.v.r6.p': {
    en: 'Included from $4/mo; custom domain, white-label and password protection at $6/mo',
    zh: '$4/月起包含；自定义域名、白标与密码保护为 $6/月',
    es: 'Incluida desde $4/mes; dominio personalizado, marca blanca y protección con contraseña a $6/mes',
    pt: 'Incluída a partir de $4/mês; domínio personalizado, white-label e proteção por senha a $6/mês',
    de: 'Ab 4 $/Monat enthalten; eigene Domain, White-Label und Passwortschutz ab 6 $/Monat',
    fr: 'Incluse dès 4 $/mois ; domaine personnalisé, marque blanche et protection par mot de passe à 6 $/mois',
    ja: '月額 $4 から付属。カスタムドメイン・白標・パスワード保護は月額 $6 から',
    ko: '월 $4부터 포함; 커스텀 도메인, 화이트라벨, 비밀번호 보호는 월 $6'
  },
  'cmpbs.v.r6.u': {
    en: '1 free page; additional public page $15/mo, private page $50/mo',
    zh: '免费 1 页；追加公开页 $15/月，私有页 $50/月',
    es: '1 página gratis; página pública adicional $15/mes, página privada $50/mes',
    pt: '1 página grátis; página pública adicional $15/mês, página privada $50/mês',
    de: '1 kostenlose Seite; zusätzliche öffentliche Seite 15 $/Monat, private Seite 50 $/Monat',
    fr: '1 page gratuite ; page publique supplémentaire 15 $/mois, page privée 50 $/mois',
    ja: '無料 1 ページ。追加の公開ページ $15/月、非公開ページ $50/月',
    ko: '무료 1개 페이지; 추가 공개 페이지 월 $15, 비공개 페이지 월 $50'
  },
  'cmpbs.r7.h': {
    en: 'On-call / phone & SMS alerts',
    zh: '值班 / 电话与短信告警',
    es: 'Guardias / alertas por teléfono y SMS',
    pt: 'Plantão / alertas por telefone e SMS',
    de: 'On-Call / Telefon- & SMS-Alarme',
    fr: 'Astreinte / alertes téléphoniques et SMS',
    ja: 'オンコール / 電話・SMS アラート',
    ko: '온콜 / 전화·SMS 알림'
  },
  'cmpbs.v.r7.p': {
    en: 'Not offered — Pingory focuses on uptime, not pager workflows',
    zh: '不提供——Pingory 专注可用性监控，不做寻呼值班流程',
    es: 'No se ofrece — Pingory se centra en la disponibilidad, no en flujos de buscapersonas',
    pt: 'Não oferecido — a Pingory foca em disponibilidade, não em fluxos de pager',
    de: 'Nicht angeboten — Pingory konzentriert sich auf Uptime, nicht auf Pager-Workflows',
    fr: 'Non proposé — Pingory se concentre sur la disponibilité, pas sur les flux de pager',
    ja: '非対応 — Pingory は稼働監視に特化し、ポケベル型ワークフローは行いません',
    ko: '제공 안 함 — Pingory는 페이저 워크플로가 아닌 업타임에 집중합니다'
  },
  'cmpbs.v.r7.u': {
    en: 'Unlimited phone and SMS alerts with responder license, on-call schedules, escalations',
    zh: 'Responder 许可证含不限量电话/短信告警、值班排班与升级策略',
    es: 'Alertas telefónicas y SMS ilimitadas con la licencia responder, horarios de guardia, escalamientos',
    pt: 'Alertas ilimitados por telefone e SMS com a licença responder, escalas de plantão, escalonamentos',
    de: 'Unbegrenzte Telefon- und SMS-Alarme mit Responder-Lizenz, On-Call-Pläne, Eskalationen',
    fr: "Alertes téléphoniques et SMS illimitées avec la licence responder, plannings d'astreinte, escalades",
    ja: 'Responder ライセンスで電話・SMS アラート無制限、オンコール表、エスカレーション',
    ko: 'Responder 라이선스로 무제한 전화·SMS 알림, 온콜 일정, 에스컬레이션'
  },
  'cmpbs.r8.h': {
    en: 'Log management',
    zh: '日志管理',
    es: 'Gestión de registros',
    pt: 'Gestão de logs',
    de: 'Log-Management',
    fr: 'Gestion des logs',
    ja: 'ログ管理',
    ko: '로그 관리'
  },
  'cmpbs.v.r8.p': {
    en: 'Not offered',
    zh: '不提供',
    es: 'No se ofrece',
    pt: 'Não oferecido',
    de: 'Nicht angeboten',
    fr: 'Non proposé',
    ja: '非対応',
    ko: '제공 안 함'
  },
  'cmpbs.v.r8.u': {
    en: 'Bundled (Logtail heritage), usage-based',
    zh: '打包提供（Logtail 血统），按用量计费',
    es: 'Incluida (herencia de Logtail), por uso',
    pt: 'Incluída (herança do Logtail), baseado em uso',
    de: 'Bündelt (Logtail-Herkunft), nutzungsbasiert',
    fr: "Incluse (héritage de Logtail), à l'usage",
    ja: 'バンドル（旧 Logtail）、従量制',
    ko: '번들 제공(Logtail 계보), 사용량 기반'
  },
  'cmpbs.v.r9.p': {
    en: 'Email, Slack, Telegram, Discord, MS Teams, webhook, PagerDuty',
    zh: '邮件、Slack、Telegram、Discord、MS Teams、webhook、PagerDuty',
    es: 'Correo electrónico, Slack, Telegram, Discord, MS Teams, webhook, PagerDuty',
    pt: 'E-mail, Slack, Telegram, Discord, MS Teams, webhook, PagerDuty',
    de: 'E-Mail, Slack, Telegram, Discord, MS Teams, Webhook, PagerDuty',
    fr: 'E-mail, Slack, Telegram, Discord, MS Teams, webhook, PagerDuty',
    ja: 'メール、Slack、Telegram、Discord、MS Teams、webhook、PagerDuty',
    ko: '이메일, Slack, Telegram, Discord, MS Teams, 웹훅, PagerDuty'
  },
  'cmpbs.v.r9.u': {
    en: 'Email, Slack + many integrations; native phone/SMS on paid',
    zh: '邮件、Slack + 大量集成；付费档含原生电话/短信',
    es: 'Correo electrónico, Slack + muchas integraciones; teléfono/SMS nativo en planes de pago',
    pt: 'E-mail, Slack + muitas integrações; telefone/SMS nativo nos planos pagos',
    de: 'E-Mail, Slack + viele Integrationen; natives Telefon/SMS im kostenpflichtigen Tarif',
    fr: 'E-mail, Slack + nombreuses intégrations ; téléphone/SMS natif en payant',
    ja: 'メール、Slack + 多数の連携。電話/SMS は有料プランでネイティブ対応',
    ko: '이메일, Slack + 다양한 통합; 유료 플랜에서 네이티브 전화/SMS'
  },
  'cmpbs.r10.h': {
    en: 'Self-hosting',
    zh: '自托管',
    es: 'Autoalojamiento',
    pt: 'Auto-hospedagem',
    de: 'Selbst-Hosting',
    fr: 'Auto-hébergement',
    ja: 'セルフホスティング',
    ko: '셀프호스팅'
  },
  'cmpbs.v.r10.p': {
    en: 'Open source (AGPL-3.0) — self-host free',
    zh: '开源（AGPL-3.0）——可免费自托管',
    es: 'Código abierto (AGPL-3.0) — autohospédate gratis',
    pt: 'Código aberto (AGPL-3.0) — auto-hospede grátis',
    de: 'Open Source (AGPL-3.0) — kostenlos selbst hosten',
    fr: 'Open source (AGPL-3.0) — auto-hébergement gratuit',
    ja: 'オープンソース（AGPL-3.0）— セルフホスト無料',
    ko: '오픈소스(AGPL-3.0) — 무료 셀프호스팅'
  },
  'cmpbs.v.r10.u': {
    en: 'Managed only',
    zh: '仅托管版',
    es: 'Solo gestionado',
    pt: 'Apenas gerenciado',
    de: 'Nur verwaltet',
    fr: 'Géré uniquement',
    ja: 'マネージドのみ',
    ko: '관리형 전용'
  },
  'cmpbs.tbl.note': {
    en: "Better Stack's free status page is genuinely useful and one of the reasons the product is popular — we say so plainly. The comparison above is about what happens when you outgrow the free tier.",
    zh: 'Better Stack 的免费状态页确实好用，也是它受欢迎的原因之一——这一点我们直说。上面对比的是你超出免费档之后会发生什么。',
    es: 'La página de estado gratuita de Better Stack es genuinamente útil y una de las razones de su popularidad — lo decimos con claridad. La comparación anterior trata de lo que ocurre cuando superas el nivel gratuito.',
    pt: 'A página de status gratuita do Better Stack é genuinamente útil e uma das razões da popularidade do produto — dizemos isso com clareza. A comparação acima trata do que acontece quando você supera o plano gratuito.',
    de: 'Die kostenlose Statusseite von Better Stack ist wirklich nützlich und einer der Gründe für die Beliebtheit des Produkts — das sagen wir offen. Der obige Vergleich dreht sich darum, was passiert, wenn du die Kostenlos-Grenze überschreitest.',
    fr: 'La page de statut gratuite de Better Stack est réellement utile et fait partie des raisons de sa popularité — nous le disons franchement. La comparaison ci-dessus porte sur ce qui se passe quand vous dépassez le palier gratuit.',
    ja: 'Better Stack の無料ステータスページは実際に有用で、同製品の人気の理由の一つです——その点は率直に認めます。上の比較は、無料枠を超えたときに何が起きるかを扱っています。',
    ko: 'Better Stack의 무료 상태 페이지는 실제로 유용하며 이 제품이 인기 있는 이유 중 하나입니다 — 솔직하게 말씀드립니다. 위 비교는 무료 티어를 넘어섰을 때 무엇이 달라지는지를 다룹니다.'
  },
  'cmpbs.bsw.h': {
    en: 'Where Better Stack still wins',
    zh: 'Better Stack 仍然更强的地方',
    es: 'Dónde sigue ganando Better Stack',
    pt: 'Onde o Better Stack ainda vence',
    de: 'Wo Better Stack weiterhin gewinnt',
    fr: 'Là où Better Stack gagne encore',
    ja: 'Better Stack がまだ勝っている点',
    ko: 'Better Stack이 여전히 앞선 부분'
  },
  'cmpbs.bsw.p': {
    en: "If your outage response involves <strong>people being woken up</strong>, Better Stack is the stronger product. Its responder license includes unlimited phone and SMS alerts, on-call schedules, escalation policies and acknowledgement flows. It also bundles log management (the former Logtail product), session replay and error tracking — a real observability suite. And the UI is, frankly, excellent. If you are running a SaaS with a team and an on-call rotation, most of Better Stack's price buys exactly that.",
    zh: '如果你的宕机响应需要<strong>把人叫醒</strong>，Better Stack 是更强的产品。它的 Responder 许可证包含不限量电话/短信告警、值班排班、升级策略与确认流程；还打包了日志管理（前 Logtail 产品）、会话回放与错误追踪——是一套真正的可观测性套件。界面也确实漂亮。如果你运营的是一个有团队、有值班轮换的 SaaS，Better Stack 的价格买到的正是这些。',
    es: 'Si tu respuesta a las caídas implica <strong>despertar a personas</strong>, Better Stack es el producto más fuerte. Su licencia responder incluye alertas telefónicas y SMS ilimitadas, horarios de guardia, políticas de escalamiento y flujos de confirmación. También incluye gestión de registros (el antiguo Logtail), repetición de sesiones y seguimiento de errores — una suite de observabilidad real. Y la interfaz es, francamente, excelente. Si diriges un SaaS con equipo y rotación de guardias, la mayor parte del precio de Better Stack paga exactamente eso.',
    pt: 'Se a sua resposta a interrupções envolve <strong>acordar pessoas</strong>, o Better Stack é o produto mais forte. Sua licença responder inclui alertas ilimitados por telefone e SMS, escalas de plantão, políticas de escalonamento e fluxos de confirmação. Também inclui gestão de logs (o antigo Logtail), replay de sessões e rastreamento de erros — uma suíte de observabilidade de verdade. E a interface é, francamente, excelente. Se você administra um SaaS com equipe e rotação de plantão, é exatamente isso que a maior parte do preço do Better Stack compra.',
    de: 'Wenn deine Reaktion auf Ausfälle darin besteht, <strong>Menschen zu wecken</strong>, ist Better Stack das stärkere Produkt. Die Responder-Lizenz enthält unbegrenzte Telefon- und SMS-Alarme, On-Call-Pläne, Eskalationsrichtlinien und Bestätigungsabläufe. Dazu kommen Log-Management (ehemals Logtail), Session-Replay und Error-Tracking — eine echte Observability-Suite. Und die Oberfläche ist, offen gesagt, ausgezeichnet. Wenn du ein SaaS mit Team und On-Call-Rotation betreibst, kaufst du mit dem Großteil des Better-Stack-Preises genau das.',
    fr: "Si votre réponse aux pannes implique de <strong>réveiller des personnes</strong>, Better Stack est le produit le plus fort. Sa licence responder inclut des alertes téléphoniques et SMS illimitées, des plannings d'astreinte, des politiques d'escalade et des flux d'accusé de réception. Elle regroupe aussi la gestion des logs (l'ancien Logtail), le session replay et le suivi des erreurs — une véritable suite d'observabilité. Et l'interface est, franchement, excellente. Si vous exploitez un SaaS avec une équipe et une rotation d'astreinte, c'est exactement ce qu'achète l'essentiel du prix de Better Stack.",
    ja: '障害対応に<strong>人を起こすこと</strong>が含まれるなら、Better Stack のほうが強力な製品です。Responder ライセンスには電話・SMS アラート無制限、オンコール表、エスカレーションポリシー、確認フローが含まれます。さらにログ管理（旧 Logtail）、セッションリプレイ、エラー追跡もバンドル——本物のオブザーバビリティスイートです。UI も率直に言って優秀。チームとオンコール体制で SaaS を運営しているなら、Better Stack の価格の大半はまさにそのために払うものです。',
    ko: '장애 대응에 <strong>사람을 깨우는 일</strong>이 포함된다면 Better Stack이 더 강한 제품입니다. Responder 라이선스에는 무제한 전화·SMS 알림, 온콜 일정, 에스컬레이션 정책, 확인 흐름이 포함됩니다. 로그 관리(구 Logtail), 세션 리플레이, 오류 추적도 번들로 제공 — 진짜 옵저버빌리티 스위트입니다. UI도 솔직히 훌륭합니다. 팀과 온콜 로테이션을 갖춘 SaaS를 운영한다면 Better Stack 가격의 대부분이 바로 그것을 사는 셈입니다.'
  },
  'cmpbs.pw.h': {
    en: 'Where Pingory wins',
    zh: 'Pingory 更强的地方',
    es: 'Dónde gana Pingory',
    pt: 'Onde a Pingory vence',
    de: 'Wo Pingory gewinnt',
    fr: 'Là où Pingory gagne',
    ja: 'Pingory が勝っている点',
    ko: 'Pingory가 앞선 부분'
  },
  'cmpbs.pw.p': {
    en: "If what you actually need is <strong>uptime monitoring and a status page</strong>, Better Stack's pricing model means you are paying for an incident-management platform you may not use. Its <strong>responder license starts around $29/month per seat</strong>, and scaling monitors is usage-based on top of that. On Pingory, <strong>$4/month gets you 100 monitors at 60-second checks with a public status page included</strong>, and $6 removes the monitor cap entirely. Pingory is also <strong>open source under AGPL-3.0</strong> — you can inspect the code or self-host it — and ships an interface in 8 languages.",
    zh: '如果你真正需要的是<strong>可用性监控和状态页</strong>，Better Stack 的定价意味着你在为可能用不上的事件管理平台买单。它的 <strong>Responder 许可证每席约 $29/月</strong>起，扩监控数还要按用量加钱。而 Pingory <strong>$4/月就能拿到 100 个监控、60 秒检查，并带公开状态页</strong>，$6 更是完全取消监控上限。Pingory 还是 <strong>AGPL-3.0 开源</strong>——可以审查代码或自托管——界面支持 8 种语言。',
    es: 'Si lo que realmente necesitas es <strong>monitorización de disponibilidad y una página de estado</strong>, el modelo de precios de Better Stack significa que pagas por una plataforma de gestión de incidentes que quizá no uses. Su <strong>licencia responder empieza en unos $29/mes por puesto</strong>, y ampliar monitores se cobra por uso además de eso. Con Pingory, <strong>$4/mes te da 100 monitores con comprobaciones de 60 segundos y una página de estado pública incluida</strong>, y $6 elimina por completo el límite de monitores. Pingory también es <strong>código abierto bajo AGPL-3.0</strong> — puedes inspeccionar el código o autoalojarlo — y ofrece interfaz en 8 idiomas.',
    pt: 'Se o que você realmente precisa é de <strong>monitoramento de disponibilidade e uma página de status</strong>, o modelo de preços do Better Stack significa pagar por uma plataforma de gestão de incidentes que talvez você não use. A <strong>licença responder começa em cerca de $29/mês por assento</strong>, e escalar monitores é cobrado por uso além disso. Na Pingory, <strong>$4/mês oferece 100 monitores com verificações de 60 segundos e uma página de status pública incluída</strong>, e $6 elimina completamente o limite de monitores. A Pingory também é <strong>código aberto sob AGPL-3.0</strong> — você pode inspecionar o código ou auto-hospedar — e oferece interface em 8 idiomas.',
    de: 'Wenn du wirklich nur <strong>Uptime-Monitoring und eine Statusseite</strong> brauchst, bedeutet das Preismodell von Better Stack, dass du für eine Incident-Management-Plattform zahlst, die du vielleicht nie nutzt. Die <strong>Responder-Lizenz kostet etwa 29 $/Monat pro Sitz</strong>, und zusätzliche Monitore kosten nutzungsbasiert extra. Bei Pingory bekommst du für <strong>4 $/Monat 100 Monitore mit 60-Sekunden-Prüfungen inklusive öffentlicher Statusseite</strong>, und 6 $ entfernt das Monitor-Limit ganz. Pingory ist außerdem <strong>Open Source unter AGPL-3.0</strong> — du kannst den Code einsehen oder selbst hosten — und bietet eine Oberfläche in 8 Sprachen.',
    fr: "Si ce dont vous avez réellement besoin est de la <strong>supervision de disponibilité et d'une page de statut</strong>, le modèle tarifaire de Better Stack signifie que vous payez une plateforme de gestion d'incidents que vous n'utiliserez peut-être pas. Sa <strong>licence responder démarre à environ 29 $/mois par siège</strong>, et l'ajout de moniteurs est facturé à l'usage en plus. Avec Pingory, <strong>4 $/mois vous donnent 100 moniteurs avec des contrôles toutes les 60 secondes et une page de statut publique incluse</strong>, et 6 $ suppriment totalement la limite de moniteurs. Pingory est aussi <strong>open source sous AGPL-3.0</strong> — vous pouvez inspecter le code ou l'auto-héberger — et propose une interface en 8 langues.",
    ja: '本当に必要なのが<strong>稼働監視とステータスページ</strong>なら、Better Stack の価格モデルは「使わないかもしれないインシデント管理プラットフォーム」に払う構造です。<strong>Responder ライセンスは 1 シート約 $29/月</strong>からで、モニター追加はその上に従量課金。Pingory なら<strong>月額 $4 でモニター 100・60 秒チェック・公開ステータスページ付き</strong>、$6 でモニター上限自体がなくなります。Pingory は <strong>AGPL-3.0 のオープンソース</strong>——コードを精査・セルフホスト可能——で、UI は 8 言語を提供。',
    ko: '실제로 필요한 것이 <strong>업타임 모니터링과 상태 페이지</strong>라면, Better Stack의 가격 모델은 어쩌면 쓰지 않을 인시던트 관리 플랫폼에 돈을 쓰는 셈입니다. <strong>Responder 라이선스는 좌석당 월 약 $29</strong>부터이며, 모니터 확장은 그 위에 사용량 기반으로 추가 과금됩니다. Pingory는 <strong>월 $4로 모니터 100개, 60초 점검, 공개 상태 페이지 포함</strong>을 제공하고, $6이면 모니터 한도가 완전히 사라집니다. Pingory는 <strong>AGPL-3.0 오픈소스</strong>라 코드를 검수하거나 셀프호스팅할 수 있고, UI는 8개 언어를 지원합니다.'
  },
  'cmpbs.types.h': {
    en: 'Monitor types',
    zh: '监控类型',
    es: 'Tipos de monitor',
    pt: 'Tipos de monitor',
    de: 'Monitor-Typen',
    fr: 'Types de moniteurs',
    ja: 'モニターの種類',
    ko: '모니터 유형'
  },
  'cmpbs.types.p': {
    en: 'Both cover the essentials: HTTP/HTTPS status, keyword content, ping, TCP port, SSL certificate expiry, DNS records, and heartbeat/cron monitoring. Pingory adds JSON/API assertions on every plan. Better Stack goes further at the high end with Playwright-based browser checks sold as metered minutes — a genuinely different capability class if you need user-journey testing.',
    zh: '两者都覆盖基础项：HTTP/HTTPS 状态、关键词内容、ping、TCP 端口、SSL 证书到期、DNS 记录与心跳/cron 监控。Pingory 在所有档位都提供 JSON/API 断言。Better Stack 在高端更进一步，提供按分钟计费的 Playwright 浏览器检查——如果你需要用户旅程测试，这是真正不同量级的能力。',
    es: 'Ambos cubren lo esencial: estado HTTP/HTTPS, contenido por palabra clave, ping, puerto TCP, caducidad de certificados SSL, registros DNS y monitorización por heartbeat/cron. Pingory añade aserciones JSON/API en todos los planes. Better Stack va más allá en la gama alta con comprobaciones de navegador basadas en Playwright vendidas en minutos medidos — una clase de capacidad realmente distinta si necesitas pruebas de recorridos de usuario.',
    pt: 'Ambos cobrem o essencial: status HTTP/HTTPS, conteúdo por palavra-chave, ping, porta TCP, validade de certificados SSL, registros DNS e monitoramento por heartbeat/cron. A Pingory adiciona asserções JSON/API em todos os planos. O Better Stack vai além na gama alta com verificações de navegador baseadas em Playwright vendidas em minutos medidos — uma classe de capacidade realmente diferente se você precisa de testes de jornada do usuário.',
    de: 'Beide decken das Wesentliche ab: HTTP/HTTPS-Status, Keyword-Inhalte, Ping, TCP-Port, SSL-Zertifikatsablauf, DNS-Einträge und Heartbeat/Cron-Monitoring. Pingory fügt in jedem Plan JSON/API-Assertions hinzu. Better Stack geht im Premiumbereich weiter mit Playwright-basierten Browser-Prüfungen nach verbrauchten Minuten — eine wirklich andere Leistungsklasse, wenn du User-Journey-Tests brauchst.',
    fr: "Les deux couvrent l'essentiel : statut HTTP/HTTPS, contenu par mot-clé, ping, port TCP, expiration des certificats SSL, enregistrements DNS et supervision heartbeat/cron. Pingory ajoute des assertions JSON/API sur toutes les offres. Better Stack va plus loin haut de gamme avec des contrôles de navigateur basés sur Playwright vendus en minutes comptées — une classe de capacité vraiment différente si vous avez besoin de tests de parcours utilisateur.",
    ja: 'どちらも基本を網羅します：HTTP/HTTPS ステータス、キーワード、ping、TCP ポート、SSL 証明書の有効期限、DNS レコード、ハートビート/cron 監視。Pingory は全プランで JSON/API アサーションを提供。Better Stack は上位帯で Playwright ベースのブラウザチェック（従量分売り）を展開——ユーザージャーニーテストが必要なら、これは本当に別クラスの機能です。',
    ko: '양쪽 모두 기본을 다룹니다: HTTP/HTTPS 상태, 키워드 콘텐츠, ping, TCP 포트, SSL 인증서 만료, DNS 레코드, 하트비트/cron 모니터링. Pingory는 모든 플랜에서 JSON/API 어설션을 추가 제공합니다. Better Stack은 상위권에서 Playwright 기반 브라우저 점검을 분 단위 종량제로 판매 — 사용자 여정 테스트가 필요하다면 진짜 다른 등급의 기능입니다.'
  },
  'cmpbs.faq.q1': {
    en: 'Is there a free Better Stack alternative?',
    zh: '有免费的 Better Stack 替代品吗？',
    es: '¿Existe una alternativa gratuita a Better Stack?',
    pt: 'Existe uma alternativa gratuita ao Better Stack?',
    de: 'Gibt es eine kostenlose Better-Stack-Alternative?',
    fr: 'Existe-t-il une alternative gratuite à Better Stack ?',
    ja: 'Better Stack の無料の代替はありますか？',
    ko: 'Better Stack의 무료 대안이 있나요?'
  },
  'cmpbs.faq.a1': {
    en: "Yes. Pingory's free plan includes <strong>50 monitors with 5-minute checks</strong> and requires no credit card. Better Stack's free tier includes 10 monitors at 3-minute checks plus one status page — better if you mainly want a free status page, worse on monitor count.",
    zh: '有。Pingory 免费档包含 <strong>50 个监控、5 分钟检查</strong>，无需信用卡。Better Stack 免费档是 10 个监控、3 分钟检查加 1 个状态页——如果你主要想要免费状态页它更好，但监控数量更少。',
    es: 'Sí. El plan gratuito de Pingory incluye <strong>50 monitores con comprobaciones cada 5 minutos</strong> y no requiere tarjeta de crédito. El nivel gratuito de Better Stack incluye 10 monitores con comprobaciones cada 3 minutos más una página de estado — mejor si quieres sobre todo una página de estado gratuita, peor en número de monitores.',
    pt: 'Sim. O plano gratuito da Pingory inclui <strong>50 monitores com verificações a cada 5 minutos</strong> e não exige cartão de crédito. O plano gratuito do Better Stack inclui 10 monitores com verificações a cada 3 minutos mais uma página de status — melhor se você quer principalmente uma página de status gratuita, pior em número de monitores.',
    de: 'Ja. Der kostenlose Pingory-Plan enthält <strong>50 Monitore mit 5-Minuten-Prüfungen</strong> und erfordert keine Kreditkarte. Die Kostenlos-Version von Better Stack enthält 10 Monitore mit 3-Minuten-Prüfungen plus eine Statusseite — besser, wenn du vor allem eine kostenlose Statusseite willst, schlechter bei der Monitor-Anzahl.',
    fr: "Oui. L'offre gratuite de Pingory inclut <strong>50 moniteurs avec des contrôles toutes les 5 minutes</strong> et ne demande pas de carte bancaire. Le palier gratuit de Better Stack inclut 10 moniteurs avec des contrôles toutes les 3 minutes plus une page de statut — mieux si vous voulez surtout une page de statut gratuite, moins bien en nombre de moniteurs.",
    ja: 'はい。Pingory の無料プランは<strong>5分間隔のチェックでモニター 50</strong> を含み、クレジットカード不要です。Better Stack の無料枠は 3分間隔のチェックでモニター 10 とステータスページ 1 ——無料ステータスページが主目的なら良い選択ですが、モニター数では劣ります。',
    ko: '네. Pingory 무료 플랜은 <strong>5분 주기 점검 모니터 50개</strong>를 포함하며 신용카드가 필요 없습니다. Better Stack 무료 티어는 3분 주기 점검 모니터 10개에 상태 페이지 1개 — 무료 상태 페이지가 주 목적이면 좋지만 모니터 수에서는 떨어집니다.'
  },
  'cmpbs.faq.q2': {
    en: 'Is Pingory cheaper than Better Stack?',
    zh: 'Pingory 比 Better Stack 便宜吗？',
    es: '¿Es Pingory más barato que Better Stack?',
    pt: 'A Pingory é mais barata que o Better Stack?',
    de: 'Ist Pingory günstiger als Better Stack?',
    fr: 'Pingory est-il moins cher que Better Stack ?',
    ja: 'Pingory は Better Stack より安いですか？',
    ko: 'Pingory가 Better Stack보다 저렴한가요?'
  },
  'cmpbs.faq.a2': {
    en: "Yes. Pingory's paid plans start at <strong>$4/month for 100 monitors</strong>. On Better Stack, 50 additional uptime monitors cost <strong>$21/month</strong> — more than Pingory's entire Starter plan — before you even count the responder license that paid tiers are built around.",
    zh: '便宜。Pingory 付费档从 <strong>$4/月（100 个监控）</strong>起。Better Stack 上追加 50 个可用性监控要 <strong>$21/月</strong>——比 Pingory 整个 Starter 档还贵——这还没算付费档赖以搭建的 Responder 许可证。',
    es: 'Sí. Los planes de pago de Pingory empiezan en <strong>$4/mes por 100 monitores</strong>. En Better Stack, 50 monitores de disponibilidad adicionales cuestan <strong>$21/mes</strong> — más que todo el plan Starter de Pingory — sin contar la licencia responder sobre la que se construyen los planes de pago.',
    pt: 'Sim. Os planos pagos da Pingory começam em <strong>$4/mês por 100 monitores</strong>. No Better Stack, 50 monitores de disponibilidade adicionais custam <strong>$21/mês</strong> — mais que o plano Starter inteiro da Pingory — sem contar a licença responder sobre a qual os planos pagos são construídos.',
    de: 'Ja. Die kostenpflichtigen Pingory-Pläne beginnen bei <strong>4 $/Monat für 100 Monitore</strong>. Bei Better Stack kosten 50 zusätzliche Uptime-Monitore <strong>21 $/Monat</strong> — mehr als der komplette Starter-Plan von Pingory — und die Responder-Lizenz, auf der die Paid-Stufen aufbauen, noch gar nicht eingerechnet.',
    fr: "Oui. Les offres payantes de Pingory démarrent à <strong>4 $/mois pour 100 moniteurs</strong>. Chez Better Stack, 50 moniteurs de disponibilité supplémentaires coûtent <strong>21 $/mois</strong> — plus que tout le plan Starter de Pingory — sans même compter la licence responder sur laquelle reposent les offres payantes.",
    ja: 'はい。Pingory の有料プランは<strong>月額 $4（モニター 100）</strong>から。Better Stack で稼働監視モニター 50 を追加すると <strong>月額 $21</strong> —— Pingory の Starter プラン全体より高い——しかも有料プランの中核である responder ライセンスはまだ含んでいません。',
    ko: '네. Pingory 유료 플랜은 <strong>월 $4(모니터 100개)</strong>부터입니다. Better Stack에서 업타임 모니터 50개를 추가하면 <strong>월 $21</strong> — Pingory의 Starter 플랜 전체보다 비쌉니다 — 유료 플랜의 핵심인 responder 라이선스는 아직 포함되지 않은 금액입니다.'
  },
  'cmpbs.faq.a3': {
    en: 'Yes — a public one from <strong>$4/month</strong>, with custom domain, white-label and password protection at <strong>$6/month</strong>. Better Stack includes one status page free; additional public pages cost $15/month and private pages $50/month.',
    zh: '有——公开状态页 <strong>$4/月</strong>起；自定义域名、白标与密码保护为 <strong>$6/月</strong>。Better Stack 免费送 1 个状态页；追加公开页 $15/月、私有页 $50/月。',
    es: 'Sí — una pública desde <strong>$4/mes</strong>, con dominio personalizado, marca blanca y protección con contraseña a <strong>$6/mes</strong>. Better Stack incluye una página de estado gratis; las páginas públicas adicionales cuestan $15/mes y las privadas $50/mes.',
    pt: 'Sim — uma pública a partir de <strong>$4/mês</strong>, com domínio personalizado, white-label e proteção por senha a <strong>$6/mês</strong>. O Better Stack inclui uma página de status grátis; páginas públicas adicionais custam $15/mês e as privadas $50/mês.',
    de: 'Ja — eine öffentliche ab <strong>4 $/Monat</strong>, mit eigener Domain, White-Label und Passwortschutz ab <strong>6 $/Monat</strong>. Better Stack enthält eine kostenlose Statusseite; zusätzliche öffentliche Seiten kosten 15 $/Monat, private 50 $/Monat.',
    fr: 'Oui — une publique dès <strong>4 $/mois</strong>, avec domaine personnalisé, marque blanche et protection par mot de passe à <strong>6 $/mois</strong>. Better Stack inclut une page de statut gratuite ; les pages publiques supplémentaires coûtent 15 $/mois et les privées 50 $/mois.',
    ja: 'はい——公開ページは<strong>月額 $4</strong> から。カスタムドメイン・白標・パスワード保護は <strong>月額 $6</strong> から。Better Stack はステータスページを 1 つ無料で含みます。追加の公開ページは $15/月、非公開ページは $50/月です。',
    ko: '네 — 공개 페이지는 <strong>월 $4</strong>부터이며, 커스텀 도메인·화이트라벨·비밀번호 보호는 <strong>월 $6</strong>부터입니다. Better Stack은 상태 페이지 1개를 무료로 포함하며, 추가 공개 페이지는 월 $15, 비공개 페이지는 월 $50입니다.'
  },
  'cmpbs.faq.q4': {
    en: 'Can I self-host Pingory?',
    zh: 'Pingory 可以自托管吗？',
    es: '¿Puedo autoalojar Pingory?',
    pt: 'Posso auto-hospedar a Pingory?',
    de: 'Kann ich Pingory selbst hosten?',
    fr: 'Puis-je auto-héberger Pingory ?',
    ja: 'Pingory はセルフホストできますか？',
    ko: 'Pingory를 셀프호스팅할 수 있나요?'
  },
  'cmpbs.faq.a4': {
    en: 'Yes. Pingory is <strong>open source under AGPL-3.0</strong> — clone it from GitHub and run it on your own server for free. Better Stack is a managed platform.',
    zh: '可以。Pingory 是 <strong>AGPL-3.0 开源</strong>——从 GitHub 克隆后就能在自己的服务器上免费运行。Better Stack 是纯托管平台。',
    es: 'Sí. Pingory es <strong>código abierto bajo AGPL-3.0</strong> — clónalo desde GitHub y ejecútalo en tu propio servidor gratis. Better Stack es una plataforma gestionada.',
    pt: 'Sim. A Pingory é <strong>código aberto sob AGPL-3.0</strong> — clone do GitHub e execute no seu próprio servidor gratuitamente. O Better Stack é uma plataforma gerenciada.',
    de: 'Ja. Pingory ist <strong>Open Source unter AGPL-3.0</strong> — von GitHub klonen und kostenlos auf deinem eigenen Server betreiben. Better Stack ist eine verwaltete Plattform.',
    fr: 'Oui. Pingory est <strong>open source sous AGPL-3.0</strong> — clonez-le depuis GitHub et exécutez-le gratuitement sur votre propre serveur. Better Stack est une plateforme gérée.',
    ja: 'はい。Pingory は <strong>AGPL-3.0 のオープンソース</strong>です——GitHub からクローンして、自分のサーバーで無料で動かせます。Better Stack はマネージド専用です。',
    ko: '네. Pingory는 <strong>AGPL-3.0 오픈소스</strong>입니다 — GitHub에서 클론해 자신의 서버에서 무료로 실행할 수 있습니다. Better Stack은 관리형 플랫폼입니다.'
  },
  'cmpbs.faq.q5': {
    en: 'When is Better Stack the better choice?',
    zh: '什么时候 Better Stack 是更好的选择？',
    es: '¿Cuándo es Better Stack la mejor opción?',
    pt: 'Quando o Better Stack é a melhor escolha?',
    de: 'Wann ist Better Stack die bessere Wahl?',
    fr: 'Quand Better Stack est-elle la meilleure option ?',
    ja: 'Better Stack のほうが良い選択なのはいつですか？',
    ko: 'Better Stack이 더 나은 선택인 경우는 언제인가요?'
  },
  'cmpbs.faq.a5': {
    en: 'When you need <strong>on-call schedules, phone/SMS alerting, escalation policies, or bundled log management</strong>. Pingory deliberately does not build pager workflows — if that is your requirement, Better Stack earns its price.',
    zh: '当你需要<strong>值班排班、电话/短信告警、升级策略或打包的日志管理</strong>时。Pingory 刻意不做寻呼值班流程——如果这是你的硬需求，Better Stack 的价格物有所值。',
    es: 'Cuando necesites <strong>horarios de guardia, alertas por teléfono/SMS, políticas de escalamiento o gestión de registros integrada</strong>. Pingory deliberadamente no crea flujos de buscapersonas — si ese es tu requisito, Better Stack justifica su precio.',
    pt: 'Quando você precisa de <strong>escalas de plantão, alertas por telefone/SMS, políticas de escalonamento ou gestão de logs integrada</strong>. A Pingory deliberadamente não cria fluxos de pager — se esse é o seu requisito, o Better Stack justifica seu preço.',
    de: 'Wenn du <strong>On-Call-Pläne, Telefon-/SMS-Alarmierung, Eskalationsrichtlinien oder integriertes Log-Management</strong> brauchst. Pingory baut bewusst keine Pager-Workflows — wenn das deine Anforderung ist, ist Better Stack sein Preis wert.',
    fr: "Quand vous avez besoin de <strong>plannings d'astreinte, d'alertes téléphone/SMS, de politiques d'escalade ou de gestion de logs intégrée</strong>. Pingory ne construit délibérément pas de flux de pager — si c'est votre exigence, Better Stack mérite son prix.",
    ja: '<strong>オンコール表、電話/SMS アラート、エスカレーションポリシー、バンドルされたログ管理</strong>が必要な場合です。Pingory は意図的にポケベル型ワークフローを作っていません——それが要件なら、Better Stack の価格には見合う価値があります。',
    ko: '<strong>온콜 일정, 전화/SMS 알림, 에스컬레이션 정책, 번들 로그 관리</strong>가 필요할 때입니다. Pingory는 의도적으로 페이저 워크플로를 만들지 않습니다 — 그것이 요구사항이라면 Better Stack의 가격은 값어치가 있습니다.'
  },
  'cmpbs.src': {
    en: "Sources: Pingory limits and prices come from the product itself (plans as published at pingory.com). Better Stack figures are from its official pricing pages, community comparisons and pricing trackers, checked in September 2026. Third-party pricing and limits change; verify current details on each vendor's site before you buy.",
    zh: '资料来源：Pingory 的配额与价格来自产品本身（pingory.com 公布的档位）。Better Stack 数据来自其官方定价页、社区对比与价格追踪站，2026 年 9 月核对。第三方价格与配额会变动；购买前请以各家官网现况为准。',
    es: 'Fuentes: los límites y precios de Pingory provienen del propio producto (planes publicados en pingory.com). Las cifras de Better Stack provienen de sus páginas oficiales de precios, comparaciones comunitarias y rastreadores de precios, verificados en septiembre de 2026. Los precios y límites de terceros cambian; verifica los detalles actuales en el sitio de cada proveedor antes de comprar.',
    pt: 'Fontes: os limites e preços da Pingory vêm do próprio produto (planos publicados em pingory.com). Os números do Better Stack vêm de suas páginas oficiais de preços, comparações da comunidade e rastreadores de preços, verificados em setembro de 2026. Preços e limites de terceiros mudam; verifique os detalhes atuais no site de cada fornecedor antes de comprar.',
    de: 'Quellen: Pingory-Limits und -Preise stammen vom Produkt selbst (veröffentlichte Pläne auf pingory.com). Better-Stack-Zahlen stammen von den offiziellen Preisseiten, Community-Vergleichen und Preis-Trackern, geprüft im September 2026. Preise und Limits Dritter ändern sich; prüfe die aktuellen Details vor dem Kauf auf der jeweiligen Anbieterseite.',
    fr: "Sources : les limites et prix de Pingory proviennent du produit lui-même (offres publiées sur pingory.com). Les chiffres de Better Stack proviennent de ses pages tarifaires officielles, de comparaisons communautaires et de suiveurs de prix, vérifiés en septembre 2026. Les prix et limites de tiers évoluent ; vérifiez les détails actuels sur le site de chaque fournisseur avant d'acheter.",
    ja: '出典：Pingory の上限と価格は製品そのもの（pingory.com 公表のプラン）から。Better Stack の数値は公式料金ページ、コミュニティ比較、価格トラッカーから 2026 年 9 月に確認しました。第三者の価格・上限は変動します。購入前に各社サイトで最新情報をご確認ください。',
    ko: '출처: Pingory의 한도와 가격은 제품 자체(pingory.com에 공개된 플랜)에서 가져왔습니다. Better Stack 수치는 공식 가격 페이지, 커뮤니티 비교, 가격 트래커에서 2026년 9월 확인했습니다. 제3자 가격과 한도는 변동됩니다. 구매 전 각 업체 사이트에서 최신 정보를 확인하세요.'
  },
  'cmpbs.more.h': {
    en: 'More comparisons',
    zh: '更多对比',
    es: 'Más comparaciones',
    pt: 'Mais comparações',
    de: 'Weitere Vergleiche',
    fr: 'Plus de comparaisons',
    ja: 'その他の比較',
    ko: '더 많은 비교'
  },
  'cmpbs.more.1': {
    en: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — the 3M+-user default against a $4 flat plan.',
    zh: '<a href="/compare/uptimerobot">Pingory 与 UptimeRobot 对比</a>——300 万+ 用户的老牌默认选择对阵 $4 统一价。',
    es: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — el clásico de 3M+ usuarios frente a un plan plano de $4.',
    pt: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — o clássico com 3M+ usuários contra um plano fixo de $4.',
    de: '<a href="/compare/uptimerobot">Pingory vs. UptimeRobot</a> — der Klassiker mit 3M+ Nutzern gegen einen Flatrate-Plan für 4 $.',
    fr: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — la valeur par défaut avec 3M+ utilisateurs face à une offre fixe à 4 $.',
    ja: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a>——ユーザー 300 万+ の定番対、一律 $4 プラン。',
    ko: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — 300만+ 사용자의 기본 선택 vs $4 정액 플랜.'
  },
  'cmpbs.more.2': {
    en: '<a href="/compare/pingdom">Pingory vs Pingdom</a> — when you do not need RUM and page-speed reports.',
    zh: '<a href="/compare/pingdom">Pingory 与 Pingdom 对比</a>——当你不需要 RUM 与页面速度报告时。',
    es: '<a href="/compare/pingdom">Pingory vs Pingdom</a> — cuando no necesitas RUM ni informes de velocidad de página.',
    pt: '<a href="/compare/pingdom">Pingory vs Pingdom</a> — quando você não precisa de RUM nem de relatórios de velocidade.',
    de: '<a href="/compare/pingdom">Pingory vs. Pingdom</a> — wenn du kein RUM und keine Page-Speed-Reports brauchst.',
    fr: "<a href=\"/compare/pingdom\">Pingory vs Pingdom</a> — quand vous n'avez pas besoin de RUM ni de rapports de vitesse.",
    ja: '<a href="/compare/pingdom">Pingory vs Pingdom</a>——RUM とページスピードレポートが不要な場合に。',
    ko: '<a href="/compare/pingdom">Pingory vs Pingdom</a> — RUM과 페이지 속도 리포트가 필요 없을 때.'
  }
};

// ===== 校验 + 合并 =====
let errors = [];
for (const [k, v] of Object.entries(M)) {
  for (const l of LANGS) if (v[l] == null || v[l] === '') errors.push(k + ' missing ' + l);
}
if (errors.length) { console.error('校验失败:\n' + errors.join('\n')); process.exit(1); }

let added = 0, skipped = 0;
for (const l of LANGS) {
  const p = path.join('public', 'i18n', l + '.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const [k, v] of Object.entries(M)) {
    if (d[k] !== undefined) { skipped++; continue; }
    d[k] = v[l]; added++;
  }
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
}
console.log('OK added=' + added + ' skipped(exist)=' + skipped + ' langs=' + LANGS.length);
