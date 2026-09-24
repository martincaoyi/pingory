// P2 多语补全（2026-09-24）：compare-pingdom.html 专属键 cmppd.*
// 用法：node tools/i18n-merge-cmppd.cjs  → 合并进 public/i18n/{en,zh,es,pt,de,fr,ja,ko}.json
// 规则：键必须 8 语齐全才写入；已存在的键不覆盖（幂等）；写回保持 2 空格缩进 + 尾换行。
'use strict';
const fs = require('fs');
const path = require('path');
const LANGS = ['en', 'zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko'];

const M = {
  'cmppd.meta.title': {
    en: 'Pingory vs Pingdom 2026: Price, Free Tier & Honest Verdict',
    zh: 'Pingory 与 Pingdom 2026 对比：价格、免费档与客观结论',
    es: 'Pingory vs Pingdom 2026: precio, nivel gratuito y veredicto honesto',
    pt: 'Pingory vs Pingdom 2026: preço, plano gratuito e veredito honesto',
    de: 'Pingory vs. Pingdom 2026: Preis, Gratis-Version und ehrliches Fazit',
    fr: 'Pingory vs Pingdom 2026 : prix, offre gratuite et verdict honnête',
    ja: 'Pingory vs Pingdom 2026：価格・無料プラン・正直な評価',
    ko: 'Pingory vs Pingdom 2026: 가격, 무료 플랜, 솔직한 평가'
  },
  'cmppd.meta.desc': {
    en: 'Pingory vs Pingdom 2026: an honest Pingdom alternative comparison — free plan vs no free plan, price per monitor, status pages, RUM features, and where Pingdom still wins.',
    zh: 'Pingory 与 Pingdom 2026 对比：客观的 Pingdom 替代品分析——有无免费档、单监控价格、状态页、RUM 能力，以及 Pingdom 仍然更强的地方。',
    es: 'Pingory vs Pingdom 2026: una comparación honesta de alternativas a Pingdom — plan gratuito vs sin plan gratuito, precio por monitor, páginas de estado, funciones de RUM y dónde sigue ganando Pingdom.',
    pt: 'Pingory vs Pingdom 2026: uma comparação honesta de alternativas ao Pingdom — plano gratuito vs sem plano gratuito, preço por monitor, páginas de status, recursos de RUM e onde o Pingdom ainda vence.',
    de: 'Pingory vs. Pingdom 2026: ein ehrlicher Vergleich mit Pingdom-Alternativen — Gratis-Plan vs. kein Gratis-Plan, Preis pro Monitor, Statusseiten, RUM-Funktionen und wo Pingdom weiterhin gewinnt.',
    fr: 'Pingory vs Pingdom 2026 : une comparaison honnête des alternatives à Pingdom — offre gratuite ou non, prix par moniteur, pages de statut, fonctions RUM et là où Pingdom gagne encore.',
    ja: 'Pingory vs Pingdom 2026：Pingdom の代替を正直に比較——無料プランの有無、モニター単位の価格、ステータスページ、RUM 機能、そして Pingdom がまだ勝っている点。',
    ko: 'Pingory vs Pingdom 2026: Pingdom 대안에 대한 솔직한 비교 — 무료 플랜 유무, 모니터당 가격, 상태 페이지, RUM 기능, 그리고 Pingdom이 여전히 앞선 부분.'
  },
  'cmppd.h1': {
    en: 'Pingory vs Pingdom (2026): An Honest Comparison',
    zh: 'Pingory 与 Pingdom（2026）对比：客观评测',
    es: 'Pingory vs Pingdom (2026): una comparación honesta',
    pt: 'Pingory vs Pingdom (2026): uma comparação honesta',
    de: 'Pingory vs. Pingdom (2026): Ein ehrlicher Vergleich',
    fr: 'Pingory vs Pingdom (2026) : une comparaison honnête',
    ja: 'Pingory vs Pingdom（2026）：正直な比較',
    ko: 'Pingory vs Pingdom (2026): 솔직한 비교'
  },
  'cmppd.ogdesc': {
    en: 'Pingory vs Pingdom 2026: free tier, price per monitor, status pages and real user monitoring compared — including where Pingdom still wins.',
    zh: 'Pingory 与 Pingdom 2026 对比：免费档、单监控价格、状态页与真实用户监控——以及 Pingdom 仍然更强的地方。',
    es: 'Pingory vs Pingdom 2026: comparación de nivel gratuito, precio por monitor, páginas de estado y monitorización de usuarios reales — incluyendo dónde sigue ganando Pingdom.',
    pt: 'Pingory vs Pingdom 2026: comparação de plano gratuito, preço por monitor, páginas de status e monitoramento de usuários reais — incluindo onde o Pingdom ainda vence.',
    de: 'Pingory vs. Pingdom 2026: Gratis-Version, Preis pro Monitor, Statusseiten und Real-User-Monitoring im Vergleich — inklusive der Punkte, wo Pingdom weiterhin gewinnt.',
    fr: 'Pingory vs Pingdom 2026 : offre gratuite, prix par moniteur, pages de statut et supervision des utilisateurs réels comparés — y compris là où Pingdom gagne encore.',
    ja: 'Pingory vs Pingdom 2026：無料プラン、モニター単位の価格、ステータスページ、RUM を比較——Pingdom がまだ勝っている点も含めて。',
    ko: 'Pingory vs Pingdom 2026: 무료 플랜, 모니터당 가격, 상태 페이지, 실사용자 모니터링 비교 — Pingdom이 여전히 앞선 부분 포함.'
  },
  'cmppd.lead': {
    en: "If you are looking for a <strong>Pingdom alternative</strong>, you are probably weighing Pingdom's reputation — 15+ years in the business, real user monitoring, detailed page-speed reports — against a bill that starts before you have monitored anything. This page compares Pingory and Pingdom (a SolarWinds company) on the numbers that show up on an invoice — <strong>free tier, price per monitor, check intervals, and status pages</strong> — and says plainly where Pingdom still wins.",
    zh: '如果你在找 <strong>Pingdom 的替代品</strong>，你大概在权衡 Pingdom 的名声——行业 15+ 年、真实用户监控、详细的页面速度报告——和一笔「还没开始监控就已经起算」的账单。本页把 Pingory 和 Pingdom（SolarWinds 旗下）放在一起比「真正会出现在账单上」的指标——<strong>免费档、单监控价格、检查间隔和状态页</strong>——Pingdom 仍然更强的地方，我们也会直说。',
    es: 'Si buscas una <strong>alternativa a Pingdom</strong>, probablemente estés sopesando la reputación de Pingdom — más de 15 años en el sector, monitorización de usuarios reales, informes detallados de velocidad — contra una factura que empieza antes de que hayas monitorizado nada. Esta página compara Pingory y Pingdom (una empresa de SolarWinds) en las cifras que aparecen en la factura — <strong>nivel gratuito, precio por monitor, intervalos de comprobación y páginas de estado</strong> — y dice con claridad dónde sigue ganando Pingdom.',
    pt: 'Se você procura uma <strong>alternativa ao Pingdom</strong>, provavelmente está pesando a reputação do Pingdom — mais de 15 anos no ramo, monitoramento de usuários reais, relatórios detalhados de velocidade — contra uma fatura que começa antes de você monitorar qualquer coisa. Esta página compara Pingory e Pingdom (uma empresa da SolarWinds) nos números que aparecem na fatura — <strong>plano gratuito, preço por monitor, intervalos de verificação e páginas de status</strong> — e diz com clareza onde o Pingdom ainda vence.',
    de: 'Wenn du eine <strong>Pingdom-Alternative</strong> suchst, wägst du vermutlich Pingdoms Ruf — über 15 Jahre Erfahrung, Real-User-Monitoring, detaillierte Page-Speed-Reports — gegen eine Rechnung, die beginnt, bevor du überhaupt etwas überwachst. Diese Seite vergleicht Pingory und Pingdom (ein SolarWinds-Unternehmen) anhand der Zahlen, die auf der Rechnung landen — <strong>Gratis-Version, Preis pro Monitor, Prüfintervalle und Statusseiten</strong> — und sagt offen, wo Pingdom weiterhin gewinnt.',
    fr: "Si vous cherchez une <strong>alternative à Pingdom</strong>, vous pesez sans doute la réputation de Pingdom — plus de 15 ans de métier, supervision des utilisateurs réels, rapports de vitesse détaillés — face à une facture qui démarre avant même que vous ayez monitoré quoi que ce soit. Cette page compare Pingory et Pingdom (une société SolarWinds) sur les chiffres qui apparaissent sur la facture — <strong>offre gratuite, prix par moniteur, intervalles de contrôle et pages de statut</strong> — et dit clairement où Pingdom gagne encore.",
    ja: '<strong>Pingdom の代替</strong>をお探しなら、業界 15 年超の実績・RUM・詳細なページスピードレポートという評判と、「何も監視する前に請求が始まる」料金のバランスを取っているところでしょう。このページでは Pingory と Pingdom（SolarWinds 傘下）を「請求書に実際に載る数字」——<strong>無料プラン、モニター単位の価格、チェック間隔、ステータスページ</strong>——で比較し、Pingdom がまだ勝っている点も率直に示します。',
    ko: '<strong>Pingdom 대안</strong>을 찾고 계시다면 업계 15년+ 경력, 실사용자 모니터링, 상세한 페이지 속도 리포트라는 평판과, 아무것도 모니터링하기 전에 시작되는 청구서를 저울질하고 계실 겁니다. 이 페이지는 Pingory와 Pingdom(SolarWinds 소속)을 청구서에 실제로 나타나는 숫자들 — <strong>무료 플랜, 모니터당 가격, 점검 간격, 상태 페이지</strong> — 로 비교하고, Pingdom이 여전히 앞선 부분도 솔직하게 말씀드립니다.'
  },
  'cmppd.short.1': {
    en: "Pingdom has <strong>no free plan</strong>. Pingory's free tier: <strong>50 monitors at 5-minute checks</strong>, no credit card required.",
    zh: 'Pingdom <strong>没有免费档</strong>。Pingory 免费档：<strong>50 个监控、5 分钟检查</strong>，无需信用卡。',
    es: 'Pingdom <strong>no tiene plan gratuito</strong>. Nivel gratuito de Pingory: <strong>50 monitores con comprobaciones cada 5 minutos</strong>, sin tarjeta de crédito.',
    pt: 'O Pingdom <strong>não tem plano gratuito</strong>. Plano gratuito da Pingory: <strong>50 monitores com verificações a cada 5 minutos</strong>, sem cartão de crédito.',
    de: 'Pingdom hat <strong>keinen kostenlosen Plan</strong>. Pingory-Kostenlosversion: <strong>50 Monitore mit 5-Minuten-Prüfungen</strong>, keine Kreditkarte nötig.',
    fr: "Pingdom n'a <strong>pas d'offre gratuite</strong>. Offre gratuite de Pingory : <strong>50 moniteurs avec des contrôles toutes les 5 minutes</strong>, sans carte bancaire.",
    ja: 'Pingdom には<strong>無料プランがありません</strong>。Pingory の無料プラン：<strong>5分間隔のチェックでモニター 50</strong>、クレジットカード不要。',
    ko: 'Pingdom에는 <strong>무료 플랜이 없습니다</strong>. Pingory 무료 플랜: <strong>5분 주기 점검 모니터 50개</strong>, 신용카드 불필요.'
  },
  'cmppd.short.2': {
    en: "Pingory's paid plans start at <strong>$4/month for 100 monitors with 60-second checks</strong>. Pingdom's Starter plan is around <strong>$10–11/month for just 10 monitors</strong>.",
    zh: 'Pingory 付费档从 <strong>$4/月（100 个监控、60 秒检查）</strong>起。Pingdom 的 Starter 档约 <strong>$10–11/月，却只有 10 个监控</strong>。',
    es: 'Los planes de pago de Pingory empiezan en <strong>$4/mes por 100 monitores con comprobaciones de 60 segundos</strong>. El plan Starter de Pingdom cuesta unos <strong>$10–11/mes por solo 10 monitores</strong>.',
    pt: 'Os planos pagos da Pingory começam em <strong>$4/mês por 100 monitores com verificações de 60 segundos</strong>. O plano Starter do Pingdom custa cerca de <strong>$10–11/mês por apenas 10 monitores</strong>.',
    de: 'Die kostenpflichtigen Pingory-Pläne beginnen bei <strong>4 $/Monat für 100 Monitore mit 60-Sekunden-Prüfungen</strong>. Pingdoms Starter-Plan kostet etwa <strong>10–11 $/Monat für nur 10 Monitore</strong>.',
    fr: 'Les offres payantes de Pingory démarrent à <strong>4 $/mois pour 100 moniteurs avec des contrôles toutes les 60 secondes</strong>. Le plan Starter de Pingdom coûte environ <strong>10–11 $/mois pour seulement 10 moniteurs</strong>.',
    ja: 'Pingory の有料プランは<strong>月額 $4（モニター 100、60秒間隔のチェック）</strong>から。Pingdom の Starter は<strong>月額約 $10–11 でモニターわずか 10</strong>。',
    ko: 'Pingory 유료 플랜은 <strong>월 $4(모니터 100개, 60초 점검)</strong>부터입니다. Pingdom의 Starter는 <strong>월 $10–11에 모니터 겨우 10개</strong>입니다.'
  },
  'cmppd.short.3': {
    en: "At <strong>$6/month</strong>, Pingory gives you <strong>unlimited monitors and 30-second checks</strong>. Pingdom's mid tier is around $25/month for 50 monitors.",
    zh: '$6/月的 Pingory 给你<strong>不限监控数 + 30 秒检查</strong>。Pingdom 的中档约 $25/月，只有 50 个监控。',
    es: 'Por <strong>$6/mes</strong>, Pingory te da <strong>monitores ilimitados y comprobaciones de 30 segundos</strong>. El nivel intermedio de Pingdom cuesta unos $25/mes por 50 monitores.',
    pt: 'Por <strong>$6/mês</strong>, a Pingory oferece <strong>monitores ilimitados e verificações de 30 segundos</strong>. O nível intermediário do Pingdom custa cerca de $25/mês por 50 monitores.',
    de: 'Für <strong>6 $/Monat</strong> bietet dir Pingory <strong>unbegrenzte Monitore und 30-Sekunden-Prüfungen</strong>. Pingdoms Mittelstufe kostet rund 25 $/Monat für 50 Monitore.',
    fr: 'Pour <strong>6 $/mois</strong>, Pingory vous donne <strong>des moniteurs illimités et des contrôles toutes les 30 secondes</strong>. Le palier intermédiaire de Pingdom coûte environ 25 $/mois pour 50 moniteurs.',
    ja: '<strong>月額 $6</strong> の Pingory なら<strong>モニター無制限・30秒間隔のチェック</strong>。Pingdom の中位プランは月額約 $25 でモニター 50。',
    ko: '<strong>월 $6</strong>이면 Pingory에서 <strong>무제한 모니터와 30초 점검</strong>을 제공합니다. Pingdom의 중간 등급은 월 약 $25에 모니터 50개입니다.'
  },
  'cmppd.short.4': {
    en: 'Pingdom wins on <strong>real user monitoring (RUM), page-speed waterfall reports, and 15+ years of brand trust</strong>.',
    zh: 'Pingdom 在<strong>真实用户监控（RUM）、页面速度瀑布报告，以及 15+ 年的品牌信任</strong>上更强。',
    es: 'Pingdom gana en <strong>monitorización de usuarios reales (RUM), informes de cascada de velocidad de página y más de 15 años de confianza de marca</strong>.',
    pt: 'O Pingdom vence em <strong>monitoramento de usuários reais (RUM), relatórios de cascata de velocidade e mais de 15 anos de confiança de marca</strong>.',
    de: 'Pingdom gewinnt bei <strong>Real-User-Monitoring (RUM), Page-Speed-Waterfall-Reports und über 15 Jahren Markenvertrauen</strong>.',
    fr: "Pingdom gagne sur <strong>la supervision des utilisateurs réels (RUM), les rapports de cascade de vitesse et plus de 15 ans de confiance de marque</strong>.",
    ja: 'Pingdom が勝るのは<strong>リアルユーザーモニタリング（RUM）、ページスピードのウォーターフォールレポート、15 年超のブランド信頼</strong>です。',
    ko: 'Pingdom은 <strong>실사용자 모니터링(RUM), 페이지 속도 워터폴 리포트, 15년+ 브랜드 신뢰</strong>에서 앞섭니다.'
  },
  'cmppd.short.5': {
    en: 'Pingory wins on <strong>free tier, price per monitor, a public status page included from $4/month, and open source code (AGPL-3.0)</strong>.',
    zh: 'Pingory 在<strong>免费档、单监控价格、$4/月即含公开状态页，以及开源代码（AGPL-3.0）</strong>上更强。',
    es: 'Pingory gana en <strong>nivel gratuito, precio por monitor, una página de estado pública incluida desde $4/mes y código abierto (AGPL-3.0)</strong>.',
    pt: 'A Pingory vence em <strong>plano gratuito, preço por monitor, uma página de status pública incluída a partir de $4/mês e código aberto (AGPL-3.0)</strong>.',
    de: 'Pingory gewinnt bei <strong>Kostenlosversion, Preis pro Monitor, ab 4 $/Monat enthaltener öffentlicher Statusseite und Open-Source-Code (AGPL-3.0)</strong>.',
    fr: "Pingory gagne sur <strong>l'offre gratuite, le prix par moniteur, une page de statut publique incluse dès 4 $/mois et le code open source (AGPL-3.0)</strong>.",
    ja: 'Pingory が勝るのは<strong>無料プラン、モニター単位の価格、月額 $4 からの公開ステータスページ付き、オープンソースコード（AGPL-3.0）</strong>です。',
    ko: 'Pingory는 <strong>무료 플랜, 모니터당 가격, 월 $4부터 공개 상태 페이지 포함, 오픈소스 코드(AGPL-3.0)</strong>에서 앞섭니다.'
  },
  'cmppd.price.note': {
    en: "Prices below are as published in September 2026; Pingdom's published price varies slightly by billing source ($10 vs $11 for Starter), so we show the range. Verify current figures on each vendor's site before you buy.",
    zh: '以下为 2026 年 9 月各渠道公布的价格；Pingdom 的公布价因渠道略有差异（Starter 有 $10 与 $11 两种口径），因此给出区间。购买前请以各家官网现价为准。',
    es: 'Los precios siguientes son los publicados en septiembre de 2026; el precio publicado de Pingdom varía ligeramente según la fuente de facturación ($10 vs $11 para Starter), por lo que mostramos el rango. Verifica las cifras actuales en el sitio de cada proveedor antes de comprar.',
    pt: 'Os preços abaixo são os publicados em setembro de 2026; o preço publicado do Pingdom varia ligeiramente conforme a fonte de cobrança ($10 vs $11 para o Starter), por isso mostramos a faixa. Verifique os valores atuais no site de cada fornecedor antes de comprar.',
    de: 'Die folgenden Preise entsprechen der Veröffentlichung von September 2026; der veröffentlichte Pingdom-Preis variiert je nach Abrechnungsquelle leicht (10 $ vs. 11 $ für Starter), daher zeigen wir die Spanne. Prüfe die aktuellen Zahlen vor dem Kauf auf der jeweiligen Anbieterseite.',
    fr: "Les prix ci-dessous sont ceux publiés en septembre 2026 ; le prix publié de Pingdom varie légèrement selon la source de facturation (10 $ vs 11 $ pour Starter), nous montrons donc la fourchette. Vérifiez les chiffres actuels sur le site de chaque fournisseur avant d'acheter.",
    ja: '以下の価格は 2026 年 9 月時点の公表値です。Pingdom の公表価格は照会元により若干異なります（Starter は $10 と $11 の両方の表記があるため幅で表示）。購入前に各社サイトで最新の数値をご確認ください。',
    ko: '아래 가격은 2026년 9월 기준 공개 가격입니다. Pingdom의 공개 가격은 결제 경로에 따라 약간 다릅니다(Starter가 $10와 $11로 표기되어 범위로 표시). 구매 전 각 업체 사이트에서 최신 가격을 확인하세요.'
  },
  'cmppd.v.r1.u': {
    en: 'None',
    zh: '无',
    es: 'Ninguno',
    pt: 'Nenhum',
    de: 'Keiner',
    fr: 'Aucun',
    ja: 'なし',
    ko: '없음'
  },
  'cmppd.v.r2.u': {
    en: 'Starter — ~$10–11/mo, 10 monitors',
    zh: 'Starter — 约 $10–11/月，10 个监控',
    es: 'Starter — ~$10–11/mes, 10 monitores',
    pt: 'Starter — ~$10–11/mês, 10 monitores',
    de: 'Starter — ca. 10–11 $/Monat, 10 Monitore',
    fr: 'Starter — ~10–11 $/mois, 10 moniteurs',
    ja: 'Starter — 約 $10–11/月、モニター 10',
    ko: 'Starter — 월 약 $10–11, 모니터 10개'
  },
  'cmppd.v.r3.p': {
    en: '100 monitors, 60-second checks',
    zh: '100 个监控，60 秒检查',
    es: '100 monitores, comprobaciones de 60 segundos',
    pt: '100 monitores, verificações de 60 segundos',
    de: '100 Monitore, 60-Sekunden-Prüfungen',
    fr: '100 moniteurs, contrôles toutes les 60 secondes',
    ja: 'モニター 100、60秒間隔のチェック',
    ko: '모니터 100개, 60초 점검'
  },
  'cmppd.v.r3.u': {
    en: '10 uptime checks, 1-minute interval',
    zh: '10 个可用性检查，1 分钟间隔',
    es: '10 comprobaciones de disponibilidad, intervalo de 1 minuto',
    pt: '10 verificações de disponibilidade, intervalo de 1 minuto',
    de: '10 Uptime-Prüfungen, 1-Minuten-Intervall',
    fr: "10 contrôles de disponibilité, intervalle d'1 minute",
    ja: '稼働監視チェック 10、1分間隔',
    ko: '업타임 점검 10개, 1분 간격'
  },
  'cmppd.r4.h': {
    en: 'Mid tier',
    zh: '中档',
    es: 'Nivel intermedio',
    pt: 'Nível intermediário',
    de: 'Mittelstufe',
    fr: 'Palier intermédiaire',
    ja: '中位プラン',
    ko: '중간 등급'
  },
  'cmppd.v.r4.p': {
    en: 'Pro — $6/mo, unlimited monitors, 30-second checks',
    zh: 'Pro — $6/月，监控数不限，30 秒检查',
    es: 'Pro — $6/mes, monitores ilimitados, comprobaciones de 30 segundos',
    pt: 'Pro — $6/mês, monitores ilimitados, verificações de 30 segundos',
    de: 'Pro — 6 $/Monat, unbegrenzte Monitore, 30-Sekunden-Prüfungen',
    fr: 'Pro — 6 $/mois, moniteurs illimités, contrôles toutes les 30 secondes',
    ja: 'Pro — 月額 $6、モニター無制限、30秒間隔のチェック',
    ko: 'Pro — 월 $6, 무제한 모니터, 30초 점검'
  },
  'cmppd.v.r4.u': {
    en: 'Professional — ~$25/mo, 50 monitors + page speed & RUM',
    zh: 'Professional — 约 $25/月，50 个监控 + 页面速度与 RUM',
    es: 'Professional — ~$25/mes, 50 monitores + velocidad de página y RUM',
    pt: 'Professional — ~$25/mês, 50 monitores + velocidade de página e RUM',
    de: 'Professional — ca. 25 $/Monat, 50 Monitore + Page-Speed & RUM',
    fr: 'Professional — ~25 $/mois, 50 moniteurs + vitesse de page et RUM',
    ja: 'Professional — 約 $25/月、モニター 50 + ページスピードと RUM',
    ko: 'Professional — 월 약 $25, 모니터 50개 + 페이지 속도 및 RUM'
  },
  'cmppd.r5.h': {
    en: 'Fastest check interval',
    zh: '最快检查间隔',
    es: 'Intervalo de comprobación más rápido',
    pt: 'Intervalo de verificação mais rápido',
    de: 'Schnellstes Prüfintervall',
    fr: 'Intervalle de contrôle le plus rapide',
    ja: '最短チェック間隔',
    ko: '가장 빠른 점검 간격'
  },
  'cmppd.v.r5.p': {
    en: '30 seconds at $6/mo',
    zh: '$6/月档为 30 秒',
    es: '30 segundos por $6/mes',
    pt: '30 segundos por $6/mês',
    de: '30 Sekunden für 6 $/Monat',
    fr: '30 secondes à 6 $/mois',
    ja: '月額 $6 で 30 秒',
    ko: '월 $6에 30초'
  },
  'cmppd.v.r5.u': {
    en: '1 minute (30-second options on higher tiers)',
    zh: '1 分钟（更高档位可选 30 秒）',
    es: '1 minuto (opciones de 30 segundos en niveles superiores)',
    pt: '1 minuto (opções de 30 segundos em níveis superiores)',
    de: '1 Minute (30-Sekunden-Optionen in höheren Stufen)',
    fr: '1 minute (options de 30 secondes sur les paliers supérieurs)',
    ja: '1 分（上位プランで 30 秒の選択肢）',
    ko: '1분 (상위 등급에서 30초 옵션)'
  },
  'cmppd.r6.h': {
    en: 'Public status page',
    zh: '公开状态页',
    es: 'Página de estado pública',
    pt: 'Página de status pública',
    de: 'Öffentliche Statusseite',
    fr: 'Page de statut publique',
    ja: '公開ステータスページ',
    ko: '공개 상태 페이지'
  },
  'cmppd.v.r6.p': {
    en: 'Included from $4/mo; custom domain, white-label and password protection at $6/mo',
    zh: '$4/月起包含；自定义域名、白标与密码保护为 $6/月',
    es: 'Incluida desde $4/mes; dominio personalizado, marca blanca y protección con contraseña a $6/mes',
    pt: 'Incluída a partir de $4/mês; domínio personalizado, white-label e proteção por senha a $6/mês',
    de: 'Ab 4 $/Monat enthalten; eigene Domain, White-Label und Passwortschutz ab 6 $/Monat',
    fr: 'Incluse dès 4 $/mois ; domaine personnalisé, marque blanche et protection par mot de passe à 6 $/mois',
    ja: '月額 $4 から付属。カスタムドメイン・白標・パスワード保護は月額 $6 から',
    ko: '월 $4부터 포함; 커스텀 도메인, 화이트라벨, 비밀번호 보호는 월 $6'
  },
  'cmppd.v.r6.u': {
    en: "Not part of Pingdom's core monitoring plans",
    zh: '不属于 Pingdom 核心监控套餐',
    es: 'No forma parte de los planes básicos de monitorización de Pingdom',
    pt: 'Não faz parte dos planos principais de monitoramento do Pingdom',
    de: 'Nicht Teil von Pingdoms Kern-Monitoring-Plänen',
    fr: 'Ne fait pas partie des offres de supervision principales de Pingdom',
    ja: 'Pingdom のコア監視プランには含まれません',
    ko: 'Pingdom의 핵심 모니터링 플랜에 포함되지 않음'
  },
  'cmppd.r7.h': {
    en: 'Real user monitoring (RUM)',
    zh: '真实用户监控（RUM）',
    es: 'Monitorización de usuarios reales (RUM)',
    pt: 'Monitoramento de usuários reais (RUM)',
    de: 'Real-User-Monitoring (RUM)',
    fr: 'Supervision des utilisateurs réels (RUM)',
    ja: 'リアルユーザーモニタリング（RUM）',
    ko: '실사용자 모니터링(RUM)'
  },
  'cmppd.v.r7.p': {
    en: 'Not offered',
    zh: '不提供',
    es: 'No se ofrece',
    pt: 'Não oferecido',
    de: 'Nicht angeboten',
    fr: 'Non proposé',
    ja: '非対応',
    ko: '제공 안 함'
  },
  'cmppd.v.r7.u': {
    en: 'Built in, with visitor geography data',
    zh: '内置，含访客地理数据',
    es: 'Integrado, con datos de geografía de visitantes',
    pt: 'Integrado, com dados de geografia dos visitantes',
    de: 'Eingebaut, mit Geodaten der Besucher',
    fr: 'Intégré, avec données géographiques des visiteurs',
    ja: '内蔵。訪問者の地域データ付き',
    ko: '내장, 방문자 지리 데이터 포함'
  },
  'cmppd.r8.h': {
    en: 'Page-speed analysis',
    zh: '页面速度分析',
    es: 'Análisis de velocidad de página',
    pt: 'Análise de velocidade de página',
    de: 'Page-Speed-Analyse',
    fr: 'Analyse de vitesse de page',
    ja: 'ページスピード分析',
    ko: '페이지 속도 분석'
  },
  'cmppd.v.r8.p': {
    en: 'Not offered',
    zh: '不提供',
    es: 'No se ofrece',
    pt: 'Não oferecido',
    de: 'Nicht angeboten',
    fr: 'Non proposé',
    ja: '非対応',
    ko: '제공 안 함'
  },
  'cmppd.v.r8.u': {
    en: 'Detailed waterfall reports',
    zh: '详细瀑布图报告',
    es: 'Informes detallados de cascada',
    pt: 'Relatórios detalhados de cascata',
    de: 'Detaillierte Waterfall-Reports',
    fr: 'Rapports de cascade détaillés',
    ja: '詳細なウォーターフォールレポート',
    ko: '상세한 워터폴 리포트'
  },
  'cmppd.v.r9.p': {
    en: 'Email, Slack, Telegram, Discord, MS Teams, webhook, PagerDuty',
    zh: '邮件、Slack、Telegram、Discord、MS Teams、webhook、PagerDuty',
    es: 'Correo electrónico, Slack, Telegram, Discord, MS Teams, webhook, PagerDuty',
    pt: 'E-mail, Slack, Telegram, Discord, MS Teams, webhook, PagerDuty',
    de: 'E-Mail, Slack, Telegram, Discord, MS Teams, Webhook, PagerDuty',
    fr: 'E-mail, Slack, Telegram, Discord, MS Teams, webhook, PagerDuty',
    ja: 'メール、Slack、Telegram、Discord、MS Teams、webhook、PagerDuty',
    ko: '이메일, Slack, Telegram, Discord, MS Teams, 웹훅, PagerDuty'
  },
  'cmppd.v.r9.u': {
    en: 'Email, SMS, Slack, PagerDuty-style integrations',
    zh: '邮件、短信、Slack、PagerDuty 式集成',
    es: 'Correo electrónico, SMS, Slack, integraciones tipo PagerDuty',
    pt: 'E-mail, SMS, Slack, integrações estilo PagerDuty',
    de: 'E-Mail, SMS, Slack, PagerDuty-artige Integrationen',
    fr: 'E-mail, SMS, Slack, intégrations de type PagerDuty',
    ja: 'メール、SMS、Slack、PagerDuty 系の連携',
    ko: '이메일, SMS, Slack, PagerDuty 스타일 통합'
  },
  'cmppd.r10.h': {
    en: 'Self-hosting',
    zh: '自托管',
    es: 'Autoalojamiento',
    pt: 'Auto-hospedagem',
    de: 'Selbst-Hosting',
    fr: 'Auto-hébergement',
    ja: 'セルフホスティング',
    ko: '셀프호스팅'
  },
  'cmppd.v.r10.p': {
    en: 'Open source (AGPL-3.0) — self-host free',
    zh: '开源（AGPL-3.0）——可免费自托管',
    es: 'Código abierto (AGPL-3.0) — autohospédate gratis',
    pt: 'Código aberto (AGPL-3.0) — auto-hospede grátis',
    de: 'Open Source (AGPL-3.0) — kostenlos selbst hosten',
    fr: 'Open source (AGPL-3.0) — auto-hébergement gratuit',
    ja: 'オープンソース（AGPL-3.0）— セルフホスト無料',
    ko: '오픈소스(AGPL-3.0) — 무료 셀프호스팅'
  },
  'cmppd.v.r10.u': {
    en: 'Closed SaaS (SolarWinds)',
    zh: '闭源 SaaS（SolarWinds）',
    es: 'SaaS cerrado (SolarWinds)',
    pt: 'SaaS fechado (SolarWinds)',
    de: 'Geschlossene SaaS (SolarWinds)',
    fr: 'SaaS fermé (SolarWinds)',
    ja: 'クローズド SaaS（SolarWinds）',
    ko: '클로즈드 SaaS(SolarWinds)'
  },
  'cmppd.tbl.note': {
    en: "Pingdom's price per monitor is the highest of the mainstream tools — roughly $1 per monitor per month on Starter. Pingory's Starter works out to about 4 cents.",
    zh: 'Pingdom 的单监控价格是主流工具里最高的——Starter 档约每监控每月 $1。Pingory 的 Starter 折算约 4 美分。',
    es: 'El precio por monitor de Pingdom es el más alto de las herramientas habituales — unos $1 por monitor al mes en Starter. El Starter de Pingory sale a unos 4 centavos.',
    pt: 'O preço por monitor do Pingdom é o mais alto entre as ferramentas comuns — cerca de $1 por monitor por mês no Starter. O Starter da Pingory sai por cerca de 4 centavos.',
    de: 'Pingdoms Preis pro Monitor ist der höchste unter den gängigen Tools — rund 1 $ pro Monitor und Monat im Starter-Plan. Pingorys Starter kommt auf etwa 4 Cent.',
    fr: 'Le prix par moniteur de Pingdom est le plus élevé des outils courants — environ 1 $ par moniteur et par mois en Starter. Le Starter de Pingory revient à environ 4 cents.',
    ja: 'Pingdom のモニター単位の価格は主流ツールの中で最も高く——Starter では 1 モニターあたり月約 $1。Pingory の Starter は約 4 セントに相当します。',
    ko: 'Pingdom의 모니터당 가격은 주류 도구 중 가장 높습니다 — Starter 기준 모니터당 월 약 $1. Pingory의 Starter는 약 4센트에 해당합니다.'
  },
  'cmppd.bsw.h': {
    en: 'Where Pingdom still wins',
    zh: 'Pingdom 仍然更强的地方',
    es: 'Dónde sigue ganando Pingdom',
    pt: 'Onde o Pingdom ainda vence',
    de: 'Wo Pingdom weiterhin gewinnt',
    fr: 'Là où Pingdom gagne encore',
    ja: 'Pingdom がまだ勝っている点',
    ko: 'Pingdom이 여전히 앞선 부분'
  },
  'cmppd.bsw.p': {
    en: "Pingdom is not trying to be a cheap uptime checker, and it shows. Its <strong>real user monitoring</strong> tracks how actual visitors experience your site, with geographic breakdowns, and its <strong>page-speed waterfall reports</strong> remain among the best in the industry. If your job is performance optimization of a high-traffic site — not just knowing when it is down — Pingdom's data is genuinely better, and Pingory does not offer an equivalent. It is also a 15-year-old brand with the enterprise procurement history to match.",
    zh: 'Pingdom 没打算做便宜的可用性检查器，这一点体现在产品上。它的<strong>真实用户监控</strong>追踪真实访客如何体验你的站点，并带地理维度拆解；<strong>页面速度瀑布报告</strong>至今仍是业界顶尖。如果你的工作是优化高流量站的性能——而不仅是知道它什么时候挂了——Pingdom 的数据确实更好，Pingory 没有对等物。它也是拥有 15 年历史、配套企业采购履历的老牌。',
    es: 'Pingdom no intenta ser un comprobador de disponibilidad barato, y se nota. Su <strong>monitorización de usuarios reales</strong> rastrea cómo los visitantes reales experimentan tu sitio, con desgloses geográficos, y sus <strong>informes de cascada de velocidad de página</strong> siguen entre los mejores del sector. Si tu trabajo es optimizar el rendimiento de un sitio de alto tráfico — no solo saber cuándo está caído — los datos de Pingdom son genuinamente mejores, y Pingory no ofrece un equivalente. Es también una marca de 15 años con el historial de compras empresariales que lo acompaña.',
    pt: 'O Pingdom não tenta ser um verificador de disponibilidade barato, e isso se nota. Seu <strong>monitoramento de usuários reais</strong> acompanha como visitantes reais experienciam seu site, com discriminações geográficas, e seus <strong>relatórios de cascata de velocidade</strong> continuam entre os melhores do setor. Se o seu trabalho é otimizar o desempenho de um site de alto tráfego — não apenas saber quando está fora do ar — os dados do Pingdom são genuinamente melhores, e a Pingory não oferece equivalente. É também uma marca de 15 anos com o histórico de compras corporativas correspondente.',
    de: 'Pingdom versucht nicht, ein billiger Uptime-Checker zu sein, und das merkt man. Sein <strong>Real-User-Monitoring</strong> verfolgt, wie echte Besucher deine Seite erleben, mit geografischen Aufschlüsselungen, und seine <strong>Page-Speed-Waterfall-Reports</strong> gehören weiterhin zur Branchenspitze. Wenn deine Aufgabe die Performance-Optimierung einer stark frequentierten Seite ist — nicht nur zu wissen, wann sie ausfällt — sind Pingdoms Daten wirklich besser, und Pingory bietet kein Äquivalent. Es ist auch eine 15 Jahre alte Marke mit passender Enterprise-Einkaufshistorie.',
    fr: "Pingdom ne cherche pas à être un vérificateur de disponibilité bon marché, et cela se voit. Sa <strong>supervision des utilisateurs réels</strong> suit la façon dont de vrais visiteurs vivent votre site, avec des ventilations géographiques, et ses <strong>rapports de cascade de vitesse</strong> restent parmi les meilleurs du secteur. Si votre travail est l'optimisation des performances d'un site à fort trafic — pas seulement savoir quand il tombe — les données de Pingdom sont vraiment meilleures, et Pingory n'offre pas d'équivalent. C'est aussi une marque de 15 ans, avec l'historique d'achats d'entreprise qui va avec.",
    ja: 'Pingdom は安価な稼働チェッカーを目指しているわけではなく、それが製品に表れています。<strong>リアルユーザーモニタリング</strong>は実際の訪問者がサイトをどう体験しているかを追跡し地域別の内訳も提供し、<strong>ページスピードのウォーターフォールレポート</strong>は今も業界最高水準です。高トラフィックサイトのパフォーマンス最適化が仕事なら——単に落ちた瞬間を知るだけでなく——Pingdom のデータは本当に優れており、Pingory には同等の機能がありません。15 年の歴史とエンタープライズ調達の実績を持つブランドでもあります。',
    ko: 'Pingdom은 저렴한 업타임 체커를 지향하지 않으며, 제품에 그대로 드러납니다. <strong>실사용자 모니터링</strong>은 실제 방문자가 사이트를 어떻게 경험하는지 추적하고 지역별 세분화를 제공하며, <strong>페이지 속도 워터폴 리포트</strong>는 여전히 업계 최상위권입니다. 고트래픽 사이트의 성능 최적화가 당신의 일이라면 — 단순히 다운된 시점을 아는 것이 아니라 — Pingdom의 데이터가 확실히 낫고, Pingory에는 대응 기능이 없습니다. 15년 역사와 엔터프라이즈 조달 이력을 갖춘 브랜드이기도 합니다.'
  },
  'cmppd.pw.h': {
    en: 'Where Pingory wins',
    zh: 'Pingory 更强的地方',
    es: 'Dónde gana Pingory',
    pt: 'Onde a Pingory vence',
    de: 'Wo Pingory gewinnt',
    fr: 'Là où Pingory gagne',
    ja: 'Pingory が勝っている点',
    ko: 'Pingory가 앞선 부분'
  },
  'cmppd.pw.p': {
    en: "If what you need is <strong>uptime monitoring with alerts and a status page</strong>, Pingdom's entry price is hard to justify: around <strong>$10–11/month for 10 monitors</strong>, with no free plan to evaluate the product first. Pingory gives you <strong>50 monitors free forever</strong>, and <strong>$4/month gets you 100 monitors at 60-second checks with a public status page included</strong> — a capability Pingdom's core plans do not bundle. At $6 the monitor cap disappears and checks drop to 30 seconds. Pingory is also <strong>open source under AGPL-3.0</strong>, so you can self-host or inspect exactly what runs.",
    zh: '如果你需要的是<strong>带告警的可用性监控和状态页</strong>，Pingdom 的入门价很难说得过去：约 <strong>$10–11/月只有 10 个监控</strong>，而且没有免费档让你先试用。Pingory 给你<strong>永久免费的 50 个监控</strong>，<strong>$4/月就有 100 个监控、60 秒检查，还带公开状态页</strong>——这是 Pingdom 核心套餐不打包的能力。$6 档取消监控上限并降到 30 秒检查。Pingory 还是 <strong>AGPL-3.0 开源</strong>，可以自托管，也可以审查它到底在跑什么。',
    es: 'Si lo que necesitas es <strong>monitorización de disponibilidad con alertas y una página de estado</strong>, el precio de entrada de Pingdom es difícil de justificar: unos <strong>$10–11/mes por 10 monitores</strong>, sin plan gratuito para evaluar el producto antes. Pingory te da <strong>50 monitores gratis para siempre</strong>, y <strong>$4/mes te da 100 monitores con comprobaciones de 60 segundos y una página de estado pública incluida</strong> — una capacidad que los planes básicos de Pingdom no incluyen. Con $6 el límite de monitores desaparece y las comprobaciones bajan a 30 segundos. Pingory también es <strong>código abierto bajo AGPL-3.0</strong>, así que puedes autoalojarlo o inspeccionar exactamente qué se ejecuta.',
    pt: 'Se o que você precisa é de <strong>monitoramento de disponibilidade com alertas e uma página de status</strong>, o preço de entrada do Pingdom é difícil de justificar: cerca de <strong>$10–11/mês por 10 monitores</strong>, sem plano gratuito para avaliar o produto antes. A Pingory oferece <strong>50 monitores grátis para sempre</strong>, e <strong>$4/mês oferece 100 monitores com verificações de 60 segundos e uma página de status pública incluída</strong> — uma capacidade que os planos principais do Pingdom não incluem. Com $6, o limite de monitores desaparece e as verificações caem para 30 segundos. A Pingory também é <strong>código aberto sob AGPL-3.0</strong>, então você pode auto-hospedar ou inspecionar exatamente o que roda.',
    de: 'Wenn du <strong>Uptime-Monitoring mit Alarmen und eine Statusseite</strong> brauchst, ist Pingdoms Einstiegspreis schwer zu rechtfertigen: rund <strong>10–11 $/Monat für 10 Monitore</strong>, ohne kostenlosen Plan, um das Produkt vorher zu testen. Pingory gibt dir <strong>50 Monitore dauerhaft gratis</strong>, und <strong>4 $/Monat bringen 100 Monitore mit 60-Sekunden-Prüfungen inklusive öffentlicher Statusseite</strong> — eine Fähigkeit, die Pingdoms Kernpläne nicht bündeln. Mit 6 $ verschwindet das Monitor-Limit und die Prüfungen sinken auf 30 Sekunden. Pingory ist außerdem <strong>Open Source unter AGPL-3.0</strong> — du kannst selbst hosten oder genau nachsehen, was läuft.',
    fr: "Si ce dont vous avez besoin est de la <strong>supervision de disponibilité avec alertes et d'une page de statut</strong>, le prix d'entrée de Pingdom est difficile à justifier : environ <strong>10–11 $/mois pour 10 moniteurs</strong>, sans offre gratuite pour évaluer le produit d'abord. Pingory vous donne <strong>50 moniteurs gratuits pour toujours</strong>, et <strong>4 $/mois vous donnent 100 moniteurs avec des contrôles toutes les 60 secondes et une page de statut publique incluse</strong> — une capacité que les offres principales de Pingdom ne regroupent pas. À 6 $, la limite de moniteurs disparaît et les contrôles passent à 30 secondes. Pingory est aussi <strong>open source sous AGPL-3.0</strong> — vous pouvez l'auto-héberger ou inspecter exactement ce qui tourne.",
    ja: '必要なのが<strong>アラート付きの稼働監視とステータスページ</strong>なら、Pingdom の入口価格は正当化しにくいものです：約 <strong>$10–11/月でモニター 10</strong>、事前に試す無料プランもありません。Pingory は<strong>モニター 50 を永久無料</strong>で、<strong>月額 $4 でモニター 100・60 秒チェック・公開ステータスページ付き</strong>——Pingdom のコアプランには含まれない能力です。$6 ではモニター上限が消え、チェックは 30 秒に。Pingory は <strong>AGPL-3.0 のオープンソース</strong>なので、セルフホストもコードの中身確認もできます。',
    ko: '필요한 것이 <strong>알림이 포함된 업타임 모니터링과 상태 페이지</strong>라면 Pingdom의 진입 가격은 정당화하기 어렵습니다: <strong>월 $10–11에 모니터 10개</strong>, 제품을 먼저 평가할 무료 플랜도 없습니다. Pingory는 <strong>모니터 50개를 영구 무료</strong>로 제공하고, <strong>월 $4로 모니터 100개, 60초 점검, 공개 상태 페이지 포함</strong>을 제공합니다 — Pingdom의 핵심 플랜에는 없는 기능입니다. $6이면 모니터 한도가 사라지고 점검이 30초로 내려갑니다. Pingory는 <strong>AGPL-3.0 오픈소스</strong>라 셀프호스팅하거나 실행되는 코드를 그대로 검수할 수 있습니다.'
  },
  'cmppd.types.h': {
    en: 'Monitor types',
    zh: '监控类型',
    es: 'Tipos de monitor',
    pt: 'Tipos de monitor',
    de: 'Monitor-Typen',
    fr: 'Types de moniteurs',
    ja: 'モニターの種類',
    ko: '모니터 유형'
  },
  'cmppd.types.p': {
    en: 'Both cover HTTP/HTTPS status checks, keyword content checks, TCP port checks, SSL certificate expiry, DNS records, and heartbeat/cron monitoring. Pingory adds ping (ICMP) and JSON/API assertions on every plan. Pingdom goes further at the high end with browser-based transaction checks — multi-step user journeys — and the RUM and page-speed products described above.',
    zh: '两者都覆盖 HTTP/HTTPS 状态检查、关键词内容检查、TCP 端口检查、SSL 证书到期、DNS 记录与心跳/cron 监控。Pingory 在所有档位额外提供 ping（ICMP）与 JSON/API 断言。Pingdom 在高端更进一步：基于浏览器的事务检查——多步用户旅程——以及上文提到的 RUM 与页面速度产品。',
    es: 'Ambos cubren comprobaciones de estado HTTP/HTTPS, comprobaciones de contenido por palabra clave, comprobaciones de puerto TCP, caducidad de certificados SSL, registros DNS y monitorización por heartbeat/cron. Pingory añade ping (ICMP) y aserciones JSON/API en todos los planes. Pingdom va más allá en la gama alta con comprobaciones de transacciones basadas en navegador — recorridos de usuario de varios pasos — y los productos de RUM y velocidad de página descritos arriba.',
    pt: 'Ambos cobrem verificações de status HTTP/HTTPS, verificações de conteúdo por palavra-chave, verificações de porta TCP, validade de certificados SSL, registros DNS e monitoramento por heartbeat/cron. A Pingory adiciona ping (ICMP) e asserções JSON/API em todos os planos. O Pingdom vai além na gama alta com verificações de transação baseadas em navegador — jornadas de usuário de várias etapas — e os produtos de RUM e velocidade de página descritos acima.',
    de: 'Beide decken HTTP/HTTPS-Statusprüfungen, Keyword-Inhaltsprüfungen, TCP-Port-Prüfungen, SSL-Zertifikatsablauf, DNS-Einträge und Heartbeat/Cron-Monitoring ab. Pingory fügt in jedem Plan Ping (ICMP) und JSON/API-Assertions hinzu. Pingdom geht im Premiumbereich weiter mit browserbasierten Transaktionsprüfungen — mehrstufigen User Journeys — und den oben beschriebenen RUM- und Page-Speed-Produkten.',
    fr: "Les deux couvrent les contrôles de statut HTTP/HTTPS, les contrôles de contenu par mot-clé, les contrôles de port TCP, l'expiration des certificats SSL, les enregistrements DNS et la supervision heartbeat/cron. Pingory ajoute le ping (ICMP) et des assertions JSON/API sur toutes les offres. Pingdom va plus loin haut de gamme avec des contrôles de transaction basés sur navigateur — des parcours utilisateur en plusieurs étapes — et les produits RUM et vitesse de page décrits ci-dessus.",
    ja: 'どちらも HTTP/HTTPS ステータスチェック、キーワードチェック、TCP ポートチェック、SSL 証明書の有効期限、DNS レコード、ハートビート/cron 監視をカバーします。Pingory は全プランで ping（ICMP）と JSON/API アサーションを追加提供。Pingdom は上位帯でブラウザベースのトランザクションチェック——複数ステップのユーザージャーニー——と前述の RUM・ページスピード製品を展開します。',
    ko: '양쪽 모두 HTTP/HTTPS 상태 점검, 키워드 콘텐츠 점검, TCP 포트 점검, SSL 인증서 만료, DNS 레코드, 하트비트/cron 모니터링을 다룹니다. Pingory는 모든 플랜에서 ping(ICMP)과 JSON/API 어설션을 추가 제공합니다. Pingdom은 상위권에서 브라우저 기반 트랜잭션 점검 — 다단계 사용자 여정 — 과 앞서 언급한 RUM·페이지 속도 제품으로 더 나아갑니다.'
  },
  'cmppd.faq.q1': {
    en: 'Is there a free Pingdom alternative?',
    zh: '有免费的 Pingdom 替代品吗？',
    es: '¿Existe una alternativa gratuita a Pingdom?',
    pt: 'Existe uma alternativa gratuita ao Pingdom?',
    de: 'Gibt es eine kostenlose Pingdom-Alternative?',
    fr: 'Existe-t-il une alternative gratuite à Pingdom ?',
    ja: 'Pingdom の無料の代替はありますか？',
    ko: 'Pingdom의 무료 대안이 있나요?'
  },
  'cmppd.faq.a1': {
    en: "Yes. Pingory's free plan includes <strong>50 monitors with 5-minute checks</strong> and no credit card. Pingdom offers a trial but no permanent free plan.",
    zh: '有。Pingory 免费档包含 <strong>50 个监控、5 分钟检查</strong>，无需信用卡。Pingdom 只有试用，没有长期免费档。',
    es: 'Sí. El plan gratuito de Pingory incluye <strong>50 monitores con comprobaciones cada 5 minutos</strong> y sin tarjeta de crédito. Pingdom ofrece una prueba pero no un plan gratuito permanente.',
    pt: 'Sim. O plano gratuito da Pingory inclui <strong>50 monitores com verificações a cada 5 minutos</strong> e sem cartão de crédito. O Pingdom oferece um teste, mas não um plano gratuito permanente.',
    de: 'Ja. Der kostenlose Pingory-Plan enthält <strong>50 Monitore mit 5-Minuten-Prüfungen</strong> und keine Kreditkarte nötig. Pingdom bietet eine Testphase, aber keinen dauerhaft kostenlosen Plan.',
    fr: "Oui. L'offre gratuite de Pingory inclut <strong>50 moniteurs avec des contrôles toutes les 5 minutes</strong> et sans carte bancaire. Pingdom propose un essai mais pas d'offre gratuite permanente.",
    ja: 'はい。Pingory の無料プランは<strong>5分間隔のチェックでモニター 50</strong>、クレジットカード不要です。Pingdom にはトライアルはありますが、永続的な無料プランはありません。',
    ko: '네. Pingory 무료 플랜은 <strong>5분 주기 점검 모니터 50개</strong>를 포함하며 신용카드가 필요 없습니다. Pingdom은 체험판은 있지만 영구 무료 플랜은 없습니다.'
  },
  'cmppd.faq.q2': {
    en: 'Is Pingory cheaper than Pingdom?',
    zh: 'Pingory 比 Pingdom 便宜吗？',
    es: '¿Es Pingory más barato que Pingdom?',
    pt: 'A Pingory é mais barata que o Pingdom?',
    de: 'Ist Pingory günstiger als Pingdom?',
    fr: 'Pingory est-il moins cher que Pingdom ?',
    ja: 'Pingory は Pingdom より安いですか？',
    ko: 'Pingory가 Pingdom보다 저렴한가요?'
  },
  'cmppd.faq.a2': {
    en: "Yes, by a wide margin. Pingory's paid plans start at <strong>$4/month for 100 monitors</strong>; Pingdom's Starter is around <strong>$10–11/month for 10 monitors</strong>. Ten times the monitors, at less than half the price.",
    zh: '便宜，而且差距很大。Pingory 付费档从 <strong>$4/月（100 个监控）</strong>起；Pingdom 的 Starter 约 <strong>$10–11/月却只有 10 个监控</strong>。十倍的监控量，不到一半的价格。',
    es: 'Sí, con diferencia. Los planes de pago de Pingory empiezan en <strong>$4/mes por 100 monitores</strong>; el Starter de Pingdom cuesta unos <strong>$10–11/mes por 10 monitores</strong>. Diez veces los monitores, por menos de la mitad del precio.',
    pt: 'Sim, com folga. Os planos pagos da Pingory começam em <strong>$4/mês por 100 monitores</strong>; o Starter do Pingdom custa cerca de <strong>$10–11/mês por 10 monitores</strong>. Dez vezes os monitores, por menos da metade do preço.',
    de: 'Ja, mit deutlichem Abstand. Die kostenpflichtigen Pingory-Pläne beginnen bei <strong>4 $/Monat für 100 Monitore</strong>; Pingdoms Starter kostet rund <strong>10–11 $/Monat für 10 Monitore</strong>. Zehnmal so viele Monitore für weniger als die Hälfte des Preises.',
    fr: 'Oui, avec une large marge. Les offres payantes de Pingory démarrent à <strong>4 $/mois pour 100 moniteurs</strong> ; le Starter de Pingdom coûte environ <strong>10–11 $/mois pour 10 moniteurs</strong>. Dix fois plus de moniteurs, à moins de la moitié du prix.',
    ja: 'はい、差は大きいです。Pingory の有料プランは<strong>月額 $4（モニター 100）</strong>から。Pingdom の Starter は約 <strong>$10–11/月でモニター 10</strong>。モニターは 10 倍で、価格は半分以下です。',
    ko: '네, 차이가 큽니다. Pingory 유료 플랜은 <strong>월 $4(모니터 100개)</strong>부터이고, Pingdom의 Starter는 약 <strong>월 $10–11에 모니터 10개</strong>입니다. 모니터는 10배, 가격은 절반 이하입니다.'
  },
  'cmppd.faq.a3': {
    en: "Yes — a public one from <strong>$4/month</strong>, with custom domain, white-label and password protection at <strong>$6/month</strong>. A comparable public status page is not part of Pingdom's core monitoring plans.",
    zh: '有——公开状态页 <strong>$4/月</strong>起；自定义域名、白标与密码保护为 <strong>$6/月</strong>。对等的公开状态页不在 Pingdom 核心监控套餐内。',
    es: 'Sí — una pública desde <strong>$4/mes</strong>, con dominio personalizado, marca blanca y protección con contraseña a <strong>$6/mes</strong>. Una página de estado pública comparable no forma parte de los planes básicos de monitorización de Pingdom.',
    pt: 'Sim — uma pública a partir de <strong>$4/mês</strong>, com domínio personalizado, white-label e proteção por senha a <strong>$6/mês</strong>. Uma página de status pública comparável não faz parte dos planos principais de monitoramento do Pingdom.',
    de: 'Ja — eine öffentliche ab <strong>4 $/Monat</strong>, mit eigener Domain, White-Label und Passwortschutz ab <strong>6 $/Monat</strong>. Eine vergleichbare öffentliche Statusseite ist nicht Teil von Pingdoms Kern-Monitoring-Plänen.',
    fr: 'Oui — une publique dès <strong>4 $/mois</strong>, avec domaine personnalisé, marque blanche et protection par mot de passe à <strong>6 $/mois</strong>. Une page de statut publique comparable ne fait pas partie des offres de supervision principales de Pingdom.',
    ja: 'はい——公開ページは<strong>月額 $4</strong> から。カスタムドメイン・白標・パスワード保護は <strong>月額 $6</strong> から。同等の公開ステータスページは Pingdom のコア監視プランには含まれません。',
    ko: '네 — 공개 페이지는 <strong>월 $4</strong>부터이며, 커스텀 도메인·화이트라벨·비밀번호 보호는 <strong>월 $6</strong>부터입니다. 대등한 공개 상태 페이지는 Pingdom의 핵심 모니터링 플랜에 포함되지 않습니다.'
  },
  'cmppd.faq.q4': {
    en: 'Does Pingory offer real user monitoring?',
    zh: 'Pingory 提供真实用户监控吗？',
    es: '¿Ofrece Pingory monitorización de usuarios reales?',
    pt: 'A Pingory oferece monitoramento de usuários reais?',
    de: 'Bietet Pingory Real-User-Monitoring?',
    fr: 'Pingory offre-t-il la supervision des utilisateurs réels ?',
    ja: 'Pingory はリアルユーザーモニタリングを提供しますか？',
    ko: 'Pingory는 실사용자 모니터링을 제공하나요?'
  },
  'cmppd.faq.a4': {
    en: "No — and this is where <strong>Pingdom wins</strong>. Pingory focuses on uptime, SSL, DNS, keyword, API and heartbeat monitoring. If you need RUM and page-speed waterfalls, Pingdom is the right tool and we will not pretend otherwise.",
    zh: '不提供——这正是 <strong>Pingdom 更强的地方</strong>。Pingory 专注于可用性、SSL、DNS、关键词、API 与心跳监控。如果你需要 RUM 和页面速度瀑布图，Pingdom 才是对的工具，我们不会装作不然。',
    es: 'No — y aquí es donde <strong>gana Pingdom</strong>. Pingory se centra en la monitorización de disponibilidad, SSL, DNS, palabras clave, API y heartbeat. Si necesitas RUM y cascadas de velocidad de página, Pingdom es la herramienta adecuada y no fingiremos lo contrario.',
    pt: 'Não — e é aqui que o <strong>Pingdom vence</strong>. A Pingory foca em monitoramento de disponibilidade, SSL, DNS, palavra-chave, API e heartbeat. Se você precisa de RUM e cascatas de velocidade de página, o Pingdom é a ferramenta certa e não fingiremos o contrário.',
    de: 'Nein — und genau hier <strong>gewinnt Pingdom</strong>. Pingory konzentriert sich auf Uptime-, SSL-, DNS-, Keyword-, API- und Heartbeat-Monitoring. Wenn du RUM und Page-Speed-Waterfalls brauchst, ist Pingdom das richtige Tool, und so tun wir nicht.',
    fr: "Non — et c'est là que <strong>Pingdom gagne</strong>. Pingory se concentre sur la supervision de disponibilité, SSL, DNS, mots-clés, API et heartbeat. Si vous avez besoin de RUM et de cascades de vitesse de page, Pingdom est le bon outil, et nous ne prétendrons pas le contraire.",
    ja: 'いいえ——そしてこここそ <strong>Pingdom が勝っている点</strong>です。Pingory は稼働・SSL・DNS・キーワード・API・ハートビート監視に集中しています。RUM とページスピードのウォーターフォールが必要なら、Pingdom が正しいツールです。私たちはそれを偽りません。',
    ko: '아니요 — 바로 여기가 <strong>Pingdom이 앞선 부분</strong>입니다. Pingory는 업타임, SSL, DNS, 키워드, API, 하트비트 모니터링에 집중합니다. RUM과 페이지 속도 워터폴이 필요하다면 Pingdom이 맞는 도구이며, 우리는 그렇지 않다고 위장하지 않습니다.'
  },
  'cmppd.src': {
    en: "Sources: Pingory limits and prices come from the product itself (plans as published at pingory.com). Pingdom figures are from its official site and pricing trackers, checked in September 2026. Third-party pricing and limits change; verify current details on each vendor's site before you buy.",
    zh: '资料来源：Pingory 的配额与价格来自产品本身（pingory.com 公布的档位）。Pingdom 数据来自其官网与价格追踪站，2026 年 9 月核对。第三方价格与配额会变动；购买前请以各家官网现况为准。',
    es: 'Fuentes: los límites y precios de Pingory provienen del propio producto (planes publicados en pingory.com). Las cifras de Pingdom provienen de su sitio oficial y de rastreadores de precios, verificados en septiembre de 2026. Los precios y límites de terceros cambian; verifica los detalles actuales en el sitio de cada proveedor antes de comprar.',
    pt: 'Fontes: os limites e preços da Pingory vêm do próprio produto (planos publicados em pingory.com). Os números do Pingdom vêm do site oficial e de rastreadores de preços, verificados em setembro de 2026. Preços e limites de terceiros mudam; verifique os detalhes atuais no site de cada fornecedor antes de comprar.',
    de: 'Quellen: Pingory-Limits und -Preise stammen vom Produkt selbst (veröffentlichte Pläne auf pingory.com). Pingdom-Zahlen stammen von der offiziellen Website und Preis-Trackern, geprüft im September 2026. Preise und Limits Dritter ändern sich; prüfe die aktuellen Details vor dem Kauf auf der jeweiligen Anbieterseite.',
    fr: "Sources : les limites et prix de Pingory proviennent du produit lui-même (offres publiées sur pingory.com). Les chiffres de Pingdom proviennent de son site officiel et de suiveurs de prix, vérifiés en septembre 2026. Les prix et limites de tiers évoluent ; vérifiez les détails actuels sur le site de chaque fournisseur avant d'acheter.",
    ja: '出典：Pingory の上限と価格は製品そのもの（pingory.com 公表のプラン）から。Pingdom の数値は公式サイトと価格トラッカーから 2026 年 9 月に確認しました。第三者の価格・上限は変動します。購入前に各社サイトで最新情報をご確認ください。',
    ko: '출처: Pingory의 한도와 가격은 제품 자체(pingory.com에 공개된 플랜)에서 가져왔습니다. Pingdom 수치는 공식 사이트와 가격 트래커에서 2026년 9월 확인했습니다. 제3자 가격과 한도는 변동됩니다. 구매 전 각 업체 사이트에서 최신 정보를 확인하세요.'
  },
  'cmppd.more.h': {
    en: 'More comparisons',
    zh: '更多对比',
    es: 'Más comparaciones',
    pt: 'Mais comparações',
    de: 'Weitere Vergleiche',
    fr: 'Plus de comparaisons',
    ja: 'その他の比較',
    ko: '더 많은 비교'
  },
  'cmppd.more.1': {
    en: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — the 3M+-user default against a $4 flat plan.',
    zh: '<a href="/compare/uptimerobot">Pingory 与 UptimeRobot 对比</a>——300 万+ 用户的老牌默认选择对阵 $4 统一价。',
    es: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — el clásico de 3M+ usuarios frente a un plan plano de $4.',
    pt: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — o clássico com 3M+ usuários contra um plano fixo de $4.',
    de: '<a href="/compare/uptimerobot">Pingory vs. UptimeRobot</a> — der Klassiker mit 3M+ Nutzern gegen einen Flatrate-Plan für 4 $.',
    fr: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — la valeur par défaut avec 3M+ utilisateurs face à une offre fixe à 4 $.',
    ja: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a>——ユーザー 300 万+ の定番対、一律 $4 プラン。',
    ko: '<a href="/compare/uptimerobot">Pingory vs UptimeRobot</a> — 300만+ 사용자의 기본 선택 vs $4 정액 플랜.'
  },
  'cmppd.more.2': {
    en: '<a href="/compare/betterstack">Pingory vs Better Stack</a> — when you do not need on-call and log management.',
    zh: '<a href="/compare/betterstack">Pingory 与 Better Stack 对比</a>——当你不需要值班与日志管理时。',
    es: '<a href="/compare/betterstack">Pingory vs Better Stack</a> — cuando no necesitas guardias ni gestión de registros.',
    pt: '<a href="/compare/betterstack">Pingory vs Better Stack</a> — quando você não precisa de plantão nem de gestão de logs.',
    de: '<a href="/compare/betterstack">Pingory vs. Better Stack</a> — wenn du kein On-Call und kein Log-Management brauchst.',
    fr: "<a href=\"/compare/betterstack\">Pingory vs Better Stack</a> — quand vous n'avez pas besoin d'astreinte ni de gestion de logs.",
    ja: '<a href="/compare/betterstack">Pingory vs Better Stack</a>——オンコールとログ管理が不要な場合に。',
    ko: '<a href="/compare/betterstack">Pingory vs Better Stack</a> — 온콜과 로그 관리가 필요 없을 때.'
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
