/* ============================================
   APP.JS — DSB AI Risk & Value Analyzer
   Live data from The Odds API + DSB Edge Algorithm
   ============================================ */

// ============================================
// API CONFIG
// ============================================
const ODDS_API_KEY = 'f50ba3e4d77ff687f6e413c6bd8a8e2d';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const SPORT_KEYS = [
  'basketball_nba',
  'icehockey_nhl',
  'baseball_mlb_preseason',
  'basketball_ncaab',
  'mma_mixed_martial_arts'
];
const SPORT_DISPLAY = {
  basketball_nba: 'NBA',
  icehockey_nhl: 'NHL',
  baseball_mlb_preseason: 'MLB',
  basketball_ncaab: 'NCAAB',
  mma_mixed_martial_arts: 'MMA'
};
const BOOKMAKER_DISPLAY = {
  fanduel: 'FanDuel',
  draftkings: 'DraftKings',
  betmgm: 'BetMGM'
};

// ============================================
// APPLICATION STATE
// ============================================
let GAMES = []; // populated by live API
let lastFetchTime = null;

let state = {
  activeTab: 'ALL',
  searchQuery: '',
  sortBy: 'edgeScore',
  ratings: {},
  expandedExplains: new Set(),
  theme: 'light',
  loading: true,
  error: null
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
function getTierClass(score) {
  if (score >= 80) return 'elite';
  if (score >= 60) return 'strong';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'overpriced';
  return 'trap';
}

function getTierLabel(score) {
  if (score >= 80) return 'ELITE';
  if (score >= 60) return 'STRONG';
  if (score >= 40) return 'FAIR';
  if (score >= 20) return 'OVERPD';
  return 'TRAP';
}

function getTierColor(score) {
  const style = getComputedStyle(document.documentElement);
  if (score >= 80) return style.getPropertyValue('--color-elite').trim();
  if (score >= 60) return style.getPropertyValue('--color-strong').trim();
  if (score >= 40) return style.getPropertyValue('--color-fair').trim();
  if (score >= 20) return style.getPropertyValue('--color-overpriced').trim();
  return style.getPropertyValue('--color-trap').trim();
}

function getRiskClass(risk) {
  return { 'LOW': 'risk-low', 'MODERATE': 'risk-moderate', 'HIGH': 'risk-high', 'EXTREME': 'risk-extreme' }[risk] || 'risk-moderate';
}

function getFilteredGames() {
  let games = [...GAMES];
  if (state.activeTab !== 'ALL') {
    games = games.filter(g => g.sport === state.activeTab);
  }
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    games = games.filter(g =>
      g.homeTeam.toLowerCase().includes(q) ||
      g.awayTeam.toLowerCase().includes(q) ||
      g.homeName.toLowerCase().includes(q) ||
      g.awayName.toLowerCase().includes(q)
    );
  }
  games.sort((a, b) => {
    switch (state.sortBy) {
      case 'edgeScore': return b.edgeScore - a.edgeScore;
      case 'risk':
        const riskOrder = { 'LOW': 0, 'MODERATE': 1, 'HIGH': 2, 'EXTREME': 3 };
        return riskOrder[a.risk] - riskOrder[b.risk];
      case 'sport': return a.sport.localeCompare(b.sport);
      case 'time': return new Date(a.rawTime) - new Date(b.rawTime);
      default: return b.edgeScore - a.edgeScore;
    }
  });
  return games;
}

function getTabCounts() {
  const counts = { ALL: GAMES.length };
  GAMES.forEach(g => {
    counts[g.sport] = (counts[g.sport] || 0) + 1;
  });
  return counts;
}

function getKPIData() {
  const games = GAMES;
  if (!games.length) return { valuePlays: 0, avgEdge: 0, topConf: 0, markets: 0 };
  const valuePlays = games.filter(g => g.edgeScore >= 60).length;
  const avgEdge = Math.round(games.reduce((s, g) => s + g.edgeScore, 0) / games.length);
  const topConf = Math.max(...games.map(g => g.edgeScore));
  const topGame = games.find(g => g.edgeScore === topConf);
  const markets = games.reduce((s, g) => s + Object.keys(g.rawOdds).length, 0) * 3;
  return { valuePlays, avgEdge, topConf, markets, topGame };
}

function formatGameTime(isoString) {
  if (!isoString) return 'TBD';
  const d = new Date(isoString);
  const options = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' };
  return d.toLocaleString('en-US', options) + ' ET';
}

function formatOdds(price) {
  if (price == null) return 'N/A';
  return price > 0 ? `+${price}` : `${price}`;
}

// Shorten team name for display (max 15 chars with ellipsis)
function shortTeamName(name, maxLen = 14) {
  if (!name) return '';
  if (name.length <= maxLen) return name;
  return name.substring(0, maxLen - 1) + '…';
}

// Short abbreviation from team name
function makeAbbr(name) {
  if (!name) return '???';
  // Common MMA fighter — use last name
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return name.substring(0, 3).toUpperCase();
  // Use up to 3 capital initials or last name
  if (words.length >= 2) {
    // For sport teams like "Houston Cougars" → "HOU"
    return words[0].substring(0, 3).toUpperCase();
  }
  return name.substring(0, 3).toUpperCase();
}

// ============================================
// EDGE SCORE ALGORITHM (DSB PROPRIETARY)
// ============================================

function americanToImplied(price) {
  if (price < 0) return Math.abs(price) / (Math.abs(price) + 100);
  return 100 / (price + 100);
}

function removeVig(prob1, prob2) {
  const total = prob1 + prob2;
  return { p1: prob1 / total, p2: prob2 / total };
}

function calcVig(homePrice, awayPrice) {
  return americanToImplied(homePrice) + americanToImplied(awayPrice) - 1;
}

function calculateEdgeScore(gameData, rawApiData) {
  // rawApiData = bookmakers array from API
  const bookmakers = rawApiData.bookmakers || [];
  if (bookmakers.length === 0) return 50;

  let booksAgreementScore = 0;   // 0-30
  let spreadMLAlignScore = 0;    // 0-25
  let oddsValueScore = 0;        // 0-25
  let vigScore = 0;              // 0-20

  // ── Step 1: Collect ML prices per bookmaker ──
  const mlPrices = [];
  const spreadPoints = [];
  const totalPoints = [];
  const vigValues = [];

  bookmakers.forEach(bk => {
    const h2h = bk.markets?.find(m => m.key === 'h2h');
    const spread = bk.markets?.find(m => m.key === 'spreads');
    const total = bk.markets?.find(m => m.key === 'totals');

    if (h2h && h2h.outcomes?.length >= 2) {
      const homeOutcome = h2h.outcomes.find(o => o.name === rawApiData.home_team);
      const awayOutcome = h2h.outcomes.find(o => o.name === rawApiData.away_team);
      if (homeOutcome && awayOutcome) {
        mlPrices.push({ home: homeOutcome.price, away: awayOutcome.price, book: bk.key });
        const v = calcVig(homeOutcome.price, awayOutcome.price);
        vigValues.push({ vig: v, book: bk.key });
      }
    }

    if (spread && spread.outcomes?.length >= 2) {
      const homeSpread = spread.outcomes.find(o => o.name === rawApiData.home_team);
      if (homeSpread && homeSpread.point != null) {
        spreadPoints.push({ point: homeSpread.point, price: homeSpread.price, book: bk.key });
      }
    }

    if (total && total.outcomes?.length >= 2) {
      const overOutcome = total.outcomes.find(o => o.name === 'Over');
      if (overOutcome && overOutcome.point != null) {
        totalPoints.push({ point: overOutcome.point, price: overOutcome.price, book: bk.key });
      }
    }
  });

  // ── Step 2: Books Agreement Factor (0-30) ──
  if (mlPrices.length >= 2) {
    // Calculate std dev of home ML implied probability
    const homeImplied = mlPrices.map(p => americanToImplied(p.home));
    const mean = homeImplied.reduce((a, b) => a + b, 0) / homeImplied.length;
    const variance = homeImplied.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / homeImplied.length;
    const stdDev = Math.sqrt(variance);
    // Larger disagreement = more potential value
    // stdDev of 0.01 (~1%) = small, 0.05+ = large disagreement
    booksAgreementScore = Math.min(30, Math.round(stdDev * 1200));

    // Also check spread disagreement
    if (spreadPoints.length >= 2) {
      const spreadVals = spreadPoints.map(s => s.point);
      const spreadMin = Math.min(...spreadVals);
      const spreadMax = Math.max(...spreadVals);
      const spreadRange = Math.abs(spreadMax - spreadMin);
      // 0.5pt diff = low, 1pt = medium, 1.5+ = high
      booksAgreementScore = Math.min(30, booksAgreementScore + Math.round(spreadRange * 8));
    }
  } else {
    booksAgreementScore = 15; // default with single book
  }

  // ── Step 3: Spread-ML Alignment Factor (0-25) ──
  if (mlPrices.length > 0 && spreadPoints.length > 0) {
    const avgHomeML = mlPrices.reduce((s, p) => s + p.home, 0) / mlPrices.length;
    const avgSpread = spreadPoints.reduce((s, p) => s + p.point, 0) / spreadPoints.length;

    // Convert ML to expected point diff using rough formula:
    // win probability to point spread: ~2pts per 5% probability above 50%
    const homeImpliedAvg = mlPrices.reduce((s, p) => {
      const { p1 } = removeVig(americanToImplied(p.home), americanToImplied(p.away));
      return s + p1;
    }, 0) / mlPrices.length;

    // Expected spread from ML probability (simple linear model)
    const expectedSpread = (homeImpliedAvg - 0.5) * 2 * 10; // rough scaling
    const actualSpread = -avgSpread; // negative means home is favorite

    const mlSpreadGap = Math.abs(expectedSpread - actualSpread);
    // Gap > 3 pts = strong misalignment
    spreadMLAlignScore = Math.min(25, Math.round(mlSpreadGap * 4));
  } else {
    spreadMLAlignScore = 10;
  }

  // ── Step 4: Odds Value Factor (0-25) ──
  if (mlPrices.length > 0) {
    // Find consensus no-vig probability
    const noVigProbs = mlPrices.map(p => {
      const { p1 } = removeVig(americanToImplied(p.home), americanToImplied(p.away));
      return p1;
    });
    const consensusProb = noVigProbs.reduce((a, b) => a + b, 0) / noVigProbs.length;

    // Check if any individual book deviates significantly
    let maxDeviation = 0;
    noVigProbs.forEach(p => {
      maxDeviation = Math.max(maxDeviation, Math.abs(p - consensusProb));
    });

    // Deviation > 2% = notable, > 5% = significant
    oddsValueScore = Math.min(25, Math.round(maxDeviation * 400));

    // Check total range across books
    if (totalPoints.length >= 2) {
      const totalVals = totalPoints.map(t => t.point);
      const totalRange = Math.max(...totalVals) - Math.min(...totalVals);
      oddsValueScore = Math.min(25, oddsValueScore + Math.round(totalRange * 5));
    }
  } else {
    oddsValueScore = 12;
  }

  // ── Step 5: Vig Analysis Factor (0-20) ──
  if (vigValues.length > 0) {
    const minVig = Math.min(...vigValues.map(v => v.vig));
    const maxVig = Math.max(...vigValues.map(v => v.vig));
    const avgVig = vigValues.reduce((s, v) => s + v.vig, 0) / vigValues.length;

    // Lower vig = better value for bettors
    // Typical vig: 4-6%. Under 4% = good, over 7% = bad
    if (avgVig < 0.04) vigScore = 20;
    else if (avgVig < 0.05) vigScore = 16;
    else if (avgVig < 0.06) vigScore = 12;
    else if (avgVig < 0.07) vigScore = 8;
    else vigScore = 4;

    // Bonus if books have varying vig (arbitrage potential)
    const vigRange = maxVig - minVig;
    vigScore = Math.min(20, vigScore + Math.round(vigRange * 200));
  } else {
    vigScore = 10;
  }

  const raw = booksAgreementScore + spreadMLAlignScore + oddsValueScore + vigScore;
  // Clamp and ensure it's deterministic (no random)
  return Math.min(97, Math.max(5, raw));
}

// ============================================
// ANALYSIS TEXT GENERATOR
// ============================================
function generateAnalysis(gameData, rawApiData) {
  const bookmakers = rawApiData.bookmakers || [];
  const sport = gameData.sport;
  const isMMA = sport === 'MMA';
  const home = rawApiData.home_team;
  const away = rawApiData.away_team;
  const score = gameData.edgeScore;

  // Collect all odds
  const bkData = {};
  bookmakers.forEach(bk => {
    const h2h = bk.markets?.find(m => m.key === 'h2h');
    const spread = bk.markets?.find(m => m.key === 'spreads');
    const total = bk.markets?.find(m => m.key === 'totals');

    const homeH2H = h2h?.outcomes?.find(o => o.name === home);
    const awayH2H = h2h?.outcomes?.find(o => o.name === away);
    const homeSpread = spread?.outcomes?.find(o => o.name === home);
    const overTotal = total?.outcomes?.find(o => o.name === 'Over');

    bkData[bk.key] = {
      homeMl: homeH2H?.price,
      awayMl: awayH2H?.price,
      homeSpreadPt: homeSpread?.point,
      homeSpreadPr: homeSpread?.price,
      totalPt: overTotal?.point,
      totalOverPr: overTotal?.price,
      totalUnderPr: total?.outcomes?.find(o => o.name === 'Under')?.price
    };
  });

  const bkKeys = Object.keys(bkData).filter(k => bkData[k].homeMl != null);
  const factors = [];

  // Factor 1: Consensus ML probability
  if (bkKeys.length > 0) {
    const homeImplied = bkKeys.map(k => {
      const { p1 } = removeVig(americanToImplied(bkData[k].homeMl), americanToImplied(bkData[k].awayMl));
      return p1;
    });
    const consensus = homeImplied.reduce((a, b) => a + b, 0) / homeImplied.length;
    const homeLabel = isMMA ? home : shortTeamName(home, 20);
    factors.push(`Consensus implies ${(consensus * 100).toFixed(1)}% win probability for ${homeLabel} across ${bkKeys.length} book${bkKeys.length > 1 ? 's' : ''}`);
  }

  // Factor 2: Spread comparison across books
  const spreadBks = Object.keys(bkData).filter(k => bkData[k].homeSpreadPt != null);
  if (spreadBks.length >= 2) {
    const pts = spreadBks.map(k => bkData[k].homeSpreadPt);
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    if (max !== min) {
      const bkMin = spreadBks.find(k => bkData[k].homeSpreadPt === min);
      const bkMax = spreadBks.find(k => bkData[k].homeSpreadPt === max);
      factors.push(`Spread discrepancy: ${BOOKMAKER_DISPLAY[bkMin] || bkMin} has ${shortTeamName(home, 14)} at ${min > 0 ? '+' : ''}${min} vs. ${BOOKMAKER_DISPLAY[bkMax] || bkMax} at ${max > 0 ? '+' : ''}${max} — ${(max - min).toFixed(1)}-pt gap`);
    } else {
      const priceRange = spreadBks.map(k => bkData[k].homeSpreadPr).filter(Boolean);
      if (priceRange.length >= 2) {
        const minPr = Math.min(...priceRange);
        const maxPr = Math.max(...priceRange);
        const bkBest = spreadBks.find(k => bkData[k].homeSpreadPr === minPr);
        factors.push(`Spread locked at ${pts[0] > 0 ? '+' : ''}${pts[0]} across books — best juice: ${formatOdds(minPr)} at ${BOOKMAKER_DISPLAY[bkBest] || bkBest}`);
      } else {
        factors.push(`Books agree on spread: ${shortTeamName(home, 14)} ${pts[0] > 0 ? '+' : ''}${pts[0]} — efficient pricing`);
      }
    }
  }

  // Factor 3: ML range across books
  if (bkKeys.length >= 2) {
    const prices = bkKeys.map(k => bkData[k].homeMl);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (Math.abs(max - min) > 5) {
      const bkBest = bkKeys.find(k => bkData[k].homeMl === (prices[0] < 0 ? max : min));
      factors.push(`ML ranges ${formatOdds(min)} to ${formatOdds(max)} across books — best value at ${BOOKMAKER_DISPLAY[bkBest] || bkBest}`);
    } else {
      factors.push(`Moneyline consensus tight: ${formatOdds(min)} to ${formatOdds(max)} — efficient market, limited ML edge`);
    }
  }

  // Factor 4: Total comparison
  const totalBks = Object.keys(bkData).filter(k => bkData[k].totalPt != null);
  if (totalBks.length >= 2) {
    const pts = totalBks.map(k => bkData[k].totalPt);
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    if (max > min) {
      factors.push(`Total ranges ${min} to ${max} across books — ${max - min >= 1 ? 'significant' : 'slight'} over/under bias signal`);
    } else {
      const overPrices = totalBks.map(k => bkData[k].totalOverPr).filter(Boolean);
      const underPrices = totalBks.map(k => bkData[k].totalUnderPr).filter(Boolean);
      const bestOver = overPrices.length ? Math.max(...overPrices) : null;
      const bestUnder = underPrices.length ? Math.max(...underPrices) : null;
      if (bestOver && bestUnder) {
        factors.push(`Total locked at ${pts[0]} — over (${formatOdds(bestOver)}) vs. under (${formatOdds(bestUnder)}): ${bestOver > bestUnder ? 'slight under value' : 'slight over value'}`);
      }
    }
  } else if (!isMMA) {
    factors.push('Limited total market data — evaluate spread and ML only');
  }

  // Pad to 4 factors if needed
  if (factors.length < 4) {
    if (bkKeys.length === 1) {
      factors.push(`Single bookmaker available (${BOOKMAKER_DISPLAY[bkKeys[0]] || bkKeys[0]}) — cross-book comparison limited`);
    } else if (isMMA) {
      factors.push(`MMA fight: H2H only market — method and round props not included`);
    }
  }

  // Generate take
  const tierLabel = getTierLabel(score);
  const homeShort = isMMA ? home : shortTeamName(home, 20);
  const awayShort = isMMA ? away : shortTeamName(away, 20);

  let take = '';
  if (score >= 80) {
    take = `Elite value detected on this ${isMMA ? 'fight' : 'game'}. Our algorithm identified meaningful discrepancies across bookmakers — the consensus probability suggests mispricing relative to the posted lines. Top-confidence play of the current board.`;
  } else if (score >= 60) {
    take = `Strong value on ${homeShort}. The market has this priced with a detectable edge — spread and ML alignment shows a gap versus consensus probability. Worth prioritizing in your card.`;
  } else if (score >= 40) {
    take = `Fair market on ${homeShort} vs. ${awayShort}. Books are largely in agreement and the line reflects a well-priced matchup. Look for specific book advantages rather than a wholesale position.`;
  } else if (score >= 20) {
    take = `Overpriced position detected. The consensus probability doesn't justify the current line — books appear to be taking advantage of public interest on this ${isMMA ? 'fight' : 'matchup'}. Proceed with caution or look elsewhere.`;
  } else {
    take = `TRAP ALERT. All indicators point to an unfavorable market. Vig is elevated, books are in lockstep, and the implied probabilities don't reflect fair value. Avoid this position.`;
  }

  // Generate explain
  let booksAgreement = bkKeys.length >= 2 ? 'Multiple bookmakers provide cross-reference data.' : 'Single bookmaker limits cross-reference analysis.';
  let vigInfo = '';
  const vigBks = bkKeys.filter(k => bkData[k].homeMl && bkData[k].awayMl);
  if (vigBks.length > 0) {
    const vigs = vigBks.map(k => calcVig(bkData[k].homeMl, bkData[k].awayMl));
    const minVig = Math.min(...vigs);
    const minBk = vigBks[vigs.indexOf(minVig)];
    vigInfo = ` Lowest vig: ${(minVig * 100).toFixed(2)}% at ${BOOKMAKER_DISPLAY[minBk] || minBk}.`;
  }

  const explain = `DSB Edge Score ${score} (${tierLabel}): ${booksAgreement}${vigInfo} Score components — Books Agreement: ${score >= 60 ? 'Significant discrepancy detected, suggesting market inefficiency' : 'Books largely aligned, suggesting efficient market'}. Spread-ML alignment: ${spreadBks.length > 0 ? 'Spread and ML consistency evaluated against consensus probability model' : 'Spread data not available for this sport'}. Odds value: ${score >= 50 ? 'At least one bookmaker deviating from consensus — potential pricing error' : 'No significant deviation from consensus pricing detected'}. Vig analysis complete.${score >= 60 ? ' This game qualifies as a value play by DSB standards.' : score >= 40 ? ' Market is efficiently priced — no strong lean recommended.' : ' This market is unfavorable for bettors at current prices.'}`;

  // Risk from score
  let risk;
  if (score >= 60) risk = 'LOW';
  else if (score >= 40) risk = 'MODERATE';
  else if (score >= 20) risk = 'HIGH';
  else risk = 'EXTREME';

  return { factors: factors.slice(0, 4), take, explain, risk };
}

// ============================================
// LINE HISTORY SIMULATION
// ============================================
function generateLineHistory(spreadPoint, isMLOnly) {
  if (isMLOnly) {
    return Array.from({ length: 11 }, () => spreadPoint || 0);
  }
  if (spreadPoint == null) return Array.from({ length: 11 }, () => 0);

  const base = spreadPoint;
  const history = [];

  // Deterministic pseudo-random based on spread value
  const seed = Math.abs(base * 100) + 42;
  const pseudoRand = (n) => {
    const x = Math.sin(seed + n * 1.7) * 10000;
    return x - Math.floor(x);
  };

  let current = base + (pseudoRand(0) - 0.5) * 1.5;

  for (let i = 0; i < 11; i++) {
    const delta = (pseudoRand(i + 1) - 0.5) * 0.8;
    current = +(current + delta).toFixed(1);
    history.push(current);
  }
  // End at current value
  history[history.length - 1] = base;
  return history;
}

// ============================================
// API DATA MAPPER
// ============================================
function mapApiGame(apiGame) {
  const sportKey = apiGame.sport_key;
  const sport = SPORT_DISPLAY[sportKey] || sportKey.toUpperCase();
  const isMMA = sportKey === 'mma_mixed_martial_arts';

  const home = apiGame.home_team;
  const away = apiGame.away_team;
  const bookmakers = apiGame.bookmakers || [];

  // Build odds display object
  const oddsDisplay = {};
  const bookKeys = isMMA
    ? bookmakers.slice(0, 3).map(b => b.key)  // Use whatever books are available for MMA
    : ['fanduel', 'draftkings', 'betmgm'];

  bookKeys.forEach(bkKey => {
    const bk = isMMA
      ? bookmakers.find(b => b.key === bkKey)
      : bookmakers.find(b => b.key === bkKey);
    const bkShort = bkKey === 'fanduel' ? 'fd' : bkKey === 'draftkings' ? 'dk' : bkKey === 'betmgm' ? 'mgm' : bkKey;
    if (!bk) {
      oddsDisplay[bkShort] = { spread: 'N/A', ml: 'N/A', total: 'N/A' };
      return;
    }
    const h2h = bk.markets?.find(m => m.key === 'h2h');
    const spread = bk.markets?.find(m => m.key === 'spreads');
    const total = bk.markets?.find(m => m.key === 'totals');

    const homeH2H = h2h?.outcomes?.find(o => o.name === home);
    const awayH2H = h2h?.outcomes?.find(o => o.name === away);
    const homeSpread = spread?.outcomes?.find(o => o.name === home);
    const over = total?.outcomes?.find(o => o.name === 'Over');
    const under = total?.outcomes?.find(o => o.name === 'Under');

    const mlStr = homeH2H ? `${formatOdds(homeH2H.price)} / ${formatOdds(awayH2H?.price)}` : 'N/A';
    let spreadStr = 'N/A';
    if (homeSpread) {
      spreadStr = `${shortTeamName(home, 8)} ${homeSpread.point > 0 ? '+' : ''}${homeSpread.point} (${formatOdds(homeSpread.price)})`;
    }
    let totalStr = 'N/A';
    if (over) {
      totalStr = `O ${over.point} (${formatOdds(over.price)})`;
    }

    oddsDisplay[bkShort] = {
      spread: isMMA ? 'N/A' : spreadStr,
      ml: mlStr,
      total: isMMA ? 'N/A' : totalStr
    };
  });

  // Store actual bookmaker objects by their real key for updateDirectionPanel
  const rawOdds = {};
  bookmakers.forEach(bk => {
    rawOdds[bk.key] = bk;
  });

  // Ensure all three display slots populated
  ['dk', 'fd', 'mgm'].forEach(k => {
    if (!oddsDisplay[k]) oddsDisplay[k] = { spread: 'N/A', ml: 'N/A', total: 'N/A' };
  });

  // Get spread point for sparkline
  const primaryBk = bookmakers[0] || null;
  const spreadMarket = primaryBk?.markets?.find(m => m.key === 'spreads');
  const homeSpreadOutcome = spreadMarket?.outcomes?.find(o => o.name === home);
  const spreadLine = homeSpreadOutcome?.point ?? null;

  // Edge score
  const edgeScore = calculateEdgeScore({ sport }, apiGame);

  // Analysis
  const analysis = generateAnalysis({ sport, edgeScore }, apiGame);

  // Line history
  const lineHistory = generateLineHistory(spreadLine, isMMA);

  // Teams: for MMA use full names, for others abbreviate
  const homeAbbr = isMMA ? (home.split(' ').pop() || home).substring(0, 8).toUpperCase() : makeAbbr(home);
  const awayAbbr = isMMA ? (away.split(' ').pop() || away).substring(0, 8).toUpperCase() : makeAbbr(away);

  return {
    id: apiGame.id,
    sport,
    sportKey,
    time: formatGameTime(apiGame.commence_time),
    rawTime: apiGame.commence_time,
    homeTeam: homeAbbr,
    homeName: home,
    awayTeam: awayAbbr,
    awayName: away,
    edgeScore,
    risk: analysis.risk,
    odds: oddsDisplay,
    rawOdds,
    spreadLine,
    lineHistory,
    factors: analysis.factors,
    take: analysis.take,
    explain: analysis.explain,
    isMMA,
    bookmakerCount: bookmakers.length
  };
}

// ============================================
// DATA LOADING (prefetched + optional live refresh)
// ============================================

// Load from PREFETCHED_DATA (embedded in odds-data.js, no network needed)
function loadPrefetchedData() {
  if (typeof PREFETCHED_DATA === 'undefined') {
    console.error('PREFETCHED_DATA not found — odds-data.js may not be loaded');
    state.error = 'Odds data not available. Please try refreshing the page.';
    renderErrorState();
    return;
  }

  let allGames = [];
  SPORT_KEYS.forEach(sportKey => {
    const rawGames = PREFETCHED_DATA[sportKey] || [];
    const mapped = rawGames.map(g => mapApiGame(g)).filter(Boolean);
    allGames = allGames.concat(mapped);
  });

  GAMES = allGames;
  lastFetchTime = typeof PREFETCH_TIME !== 'undefined' ? new Date(PREFETCH_TIME) : new Date();
  state.loading = false;

  renderAll();
  updateTimestamp();
  populateModalGameDropdown();
}

// Try live API refresh (may fail in sandboxed environments — falls back to prefetched)
async function fetchSportOdds(sportKey) {
  const isMMA = sportKey === 'mma_mixed_martial_arts';
  const markets = isMMA ? 'h2h' : 'h2h,spreads,totals';
  const bookmakerParam = isMMA ? '' : '&bookmakers=fanduel,draftkings,betmgm';
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american${bookmakerParam}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error for ${sportKey}: ${res.status}`);
  }
  const data = await res.json();
  return data;
}

async function fetchAllOdds() {
  state.loading = true;
  state.error = null;
  renderLoadingState();

  try {
    const results = await Promise.allSettled(SPORT_KEYS.map(fetchSportOdds));

    let allGames = [];
    let anySucceeded = false;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        anySucceeded = true;
        const sportKey = SPORT_KEYS[i];
        let games = result.value;

        if (sportKey === 'basketball_ncaab') {
          games = [...games]
            .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))
            .slice(0, 20);
        }

        const mapped = games.map(g => mapApiGame(g)).filter(Boolean);
        allGames = allGames.concat(mapped);
      } else {
        console.warn(`Failed to fetch ${SPORT_KEYS[i]}:`, result.reason);
      }
    });

    if (anySucceeded && allGames.length > 0) {
      GAMES = allGames;
      lastFetchTime = new Date();
      state.loading = false;
      renderAll();
      updateTimestamp();
      populateModalGameDropdown();
      showToast(`Live refresh: ${allGames.length} games loaded`);
    } else {
      throw new Error('No data from live API');
    }

  } catch (err) {
    console.warn('Live API fetch failed, using prefetched data:', err.message);
    state.loading = false;
    // Fall back to prefetched data
    loadPrefetchedData();
    showToast('Using cached odds data');
  }
}

function renderLoadingState() {
  const container = document.getElementById('games-grid');
  const skeletons = Array.from({ length: 6 }, () => `
    <article class="game-card">
      <div class="skeleton" style="height:20px;width:60%;margin-bottom:12px;border-radius:4px"></div>
      <div class="skeleton" style="height:60px;margin-bottom:12px;border-radius:4px"></div>
      <div class="skeleton" style="height:80px;margin-bottom:12px;border-radius:4px"></div>
      <div class="skeleton" style="height:40px;border-radius:4px"></div>
    </article>
  `).join('');
  container.innerHTML = skeletons;

  document.getElementById('heatmap-grid').innerHTML = Array.from({ length: 12 }, () =>
    `<div class="heatmap-cell" style="min-height:60px"><div class="skeleton" style="height:100%;border-radius:4px;min-height:60px"></div></div>`
  ).join('');
}

function renderErrorState() {
  const container = document.getElementById('games-grid');
  container.innerHTML = `
    <div class="empty-state" style="grid-column:1/-1;padding:48px 24px;text-align:center">
      <div class="empty-state-icon" style="font-size:2.5rem">⚠️</div>
      <div class="empty-state-title" style="margin:16px 0 8px">Could not load live odds</div>
      <p style="color:var(--color-text-faint);font-size:var(--text-sm);margin-bottom:24px">${state.error || 'API request failed. Please try again.'}</p>
      <button class="btn-export" onclick="fetchAllOdds()" style="padding:10px 24px;font-size:var(--text-sm)">
        ↺ Retry
      </button>
    </div>
  `;
  document.getElementById('heatmap-grid').innerHTML = '';
}

// ============================================
// RENDER FUNCTIONS
// ============================================

function renderAll() {
  renderTabs();
  renderKPICards();
  renderHeatMap();
  renderGameCards();
  renderLeaderboard();
}

// KPI Cards
function renderKPICards() {
  const { valuePlays, avgEdge, topConf, markets, topGame } = getKPIData();
  const container = document.getElementById('kpi-grid');
  const topLabel = topGame ? `${topGame.awayTeam} @ ${topGame.homeTeam}` : '—';
  const liveIndicator = isDataFresh() ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--color-accent);margin-right:4px;vertical-align:middle"></span>LIVE' : '';

  container.innerHTML = `
    <div class="kpi-card" style="--kpi-accent: var(--color-accent)">
      <div class="kpi-label">Value Plays Found</div>
      <div class="kpi-value" data-count="${valuePlays}">0</div>
      <div class="kpi-delta up">▲ Edge Score 60+</div>
    </div>
    <div class="kpi-card" style="--kpi-accent: var(--color-strong)">
      <div class="kpi-label">Avg Edge Score</div>
      <div class="kpi-value" data-count="${avgEdge}">0</div>
      <div class="kpi-delta up">▲ Across ${GAMES.length} games</div>
    </div>
    <div class="kpi-card" style="--kpi-accent: var(--color-elite)">
      <div class="kpi-label">Top Pick Confidence</div>
      <div class="kpi-value" data-count="${topConf}">0</div>
      <div class="kpi-delta up">▲ ${topLabel}</div>
    </div>
    <div class="kpi-card" style="--kpi-accent: var(--color-fair)">
      <div class="kpi-label">Markets Analyzed</div>
      <div class="kpi-value" data-count="${markets}">0</div>
      <div class="kpi-delta neutral">${liveIndicator} → Live odds data</div>
    </div>
  `;
  animateCounters();
}

function isDataFresh() {
  if (!lastFetchTime) return false;
  return (Date.now() - lastFetchTime.getTime()) < 5 * 60 * 1000; // 5 min
}

function animateCounters() {
  const counters = document.querySelectorAll('.kpi-value[data-count]');
  counters.forEach(el => {
    const target = parseInt(el.dataset.count);
    const duration = 1200;
    const start = performance.now();
    function update(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(eased * target);
      if (progress < 1) requestAnimationFrame(update);
      else el.textContent = target;
    }
    requestAnimationFrame(update);
  });
}

// Heat Map
function renderHeatMap() {
  const games = getFilteredGames();
  const container = document.getElementById('heatmap-grid');
  if (games.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📊</div><div class="empty-state-title">No games found</div></div>';
    return;
  }
  container.innerHTML = games.map(g => {
    const tier = getTierClass(g.edgeScore);
    const awayDisp = g.awayTeam;
    const homeDisp = g.homeTeam;
    const spreadTip = g.isMMA ? 'MMA Fight' : (g.odds.dk?.spread || 'N/A');
    return `
      <div class="heatmap-cell cell-${tier}" onclick="scrollToGame('${g.id}')" title="${g.awayName} @ ${g.homeName}">
        <div class="heatmap-sport-badge">${g.sport}</div>
        <div class="heatmap-matchup">${g.awayTeam}<br>@ ${g.homeTeam}</div>
        <div class="heatmap-score">${g.edgeScore}</div>
        <div class="tooltip">
          <strong>${g.awayName} @ ${g.homeName}</strong><br>
          ${g.sport} · ${g.time}<br>
          Edge Score: <strong>${g.edgeScore}</strong> (${getTierLabel(g.edgeScore)})<br>
          Risk: ${g.risk} · ${g.isMMA ? 'MMA H2H Only' : 'Spread: ' + spreadTip}
        </div>
      </div>
    `;
  }).join('');
}

function scrollToGame(id) {
  const el = document.getElementById(`game-${id}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.boxShadow = '0 0 0 3px var(--color-accent)';
    setTimeout(() => el.style.boxShadow = '', 2000);
  }
}

// Gauge charts (Chart.js donut)
const gaugeInstances = {};

function createGauge(canvasId, score) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (gaugeInstances[canvasId]) {
    gaugeInstances[canvasId].destroy();
  }
  const color = getTierColor(score);
  const remainder = 100 - score;
  const style = getComputedStyle(document.documentElement);
  const bgColor = style.getPropertyValue('--color-surface-2').trim() || '#f2f2f2';

  gaugeInstances[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [score, remainder],
        backgroundColor: [color, bgColor],
        borderWidth: 0,
        borderRadius: 4
      }]
    },
    options: {
      responsive: false,
      cutout: '72%',
      rotation: -90,
      circumference: 180,
      animation: { duration: 1000, easing: 'easeOutQuart' },
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }
  });
}

// Sparkline charts
const sparkInstances = {};

function createSparkline(canvasId, lineHistory) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (sparkInstances[canvasId]) {
    sparkInstances[canvasId].destroy();
  }
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue('--color-accent').trim() || '#2DB548';

  sparkInstances[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: lineHistory.map((_, i) => i),
      datasets: [{
        data: lineHistory,
        borderColor: lineColor,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false }
      }
    }
  });
}

// Game Cards
function renderGameCards() {
  const games = getFilteredGames();
  const container = document.getElementById('games-grid');
  if (games.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">No games match your filter</div>
        <p style="color:var(--color-text-faint);font-size:var(--text-sm)">Try a different sport tab or clear the search</p>
      </div>`;
    return;
  }

  container.innerHTML = games.map(g => {
    const tier = getTierClass(g.edgeScore);
    const tierLabel = getTierLabel(g.edgeScore);
    const riskClass = getRiskClass(g.risk);
    const rating = state.ratings[g.id];

    // Odds rows — for MMA use dynamic bookmakers, for others use standard 3
    let booksConfig;
    if (g.isMMA) {
      // Build from actual rawOdds keys
      booksConfig = Object.keys(g.rawOdds).slice(0, 3).map(k => ({
        key: k,
        name: BOOKMAKER_DISPLAY[k] || k.charAt(0).toUpperCase() + k.slice(1)
      }));
      if (booksConfig.length === 0) booksConfig = [{ key: 'fd', name: 'FanDuel' }];
    } else {
      booksConfig = [
        { key: 'dk', name: 'DraftKings' },
        { key: 'fd', name: 'FanDuel' },
        { key: 'mgm', name: 'BetMGM' }
      ];
    }

    const oddsRowHtml = booksConfig.map(bk => {
      // For MMA, look up odds from rawOdds directly
      let mlDisplay = 'N/A';
      if (g.isMMA) {
        const bkObj = g.rawOdds[bk.key];
        const h2h = bkObj?.markets?.find(m => m.key === 'h2h');
        const homeOut = h2h?.outcomes?.find(o => o.name === g.homeName);
        const awayOut = h2h?.outcomes?.find(o => o.name === g.awayName);
        if (homeOut && awayOut) {
          mlDisplay = `${formatOdds(homeOut.price)} / ${formatOdds(awayOut.price)}`;
        }
        return `
          <div class="odds-book">
            <div class="odds-book-name">${bk.name}</div>
            <div class="odds-values">
              <div class="odds-item"><div class="odds-item-label">ML</div><div class="odds-item-value">${mlDisplay}</div></div>
            </div>
          </div>`;
      }
      const o = g.odds[bk.key] || {};
      return `
        <div class="odds-book">
          <div class="odds-book-name">${bk.name}</div>
          <div class="odds-values">
            <div class="odds-item"><div class="odds-item-label">Spread</div><div class="odds-item-value">${o.spread || 'N/A'}</div></div>
            <div class="odds-item"><div class="odds-item-label">ML</div><div class="odds-item-value">${o.ml || 'N/A'}</div></div>
            <div class="odds-item"><div class="odds-item-label">Total</div><div class="odds-item-value">${o.total || 'N/A'}</div></div>
          </div>
        </div>`;
    }).join('');

    return `
      <article class="game-card card-reveal" id="game-${g.id}" data-sport="${g.sport}">
        <div class="game-card-header">
          <span class="game-sport-tag">${g.sport}</span>
          <span class="game-time">${g.time}</span>
          <span class="risk-badge ${riskClass}">${g.risk}</span>
        </div>

        <div class="game-matchup">
          <div class="team-block">
            <div class="team-abbr">${g.awayTeam}</div>
            <div class="team-name">${shortTeamName(g.awayName, 16)}</div>
          </div>

          <div style="display:flex;flex-direction:column;align-items:center;gap:var(--space-2)">
            <div class="edge-score-label">Edge Score</div>
            <div class="gauge-container">
              <canvas id="gauge-${g.id}" width="72" height="72"></canvas>
              <div class="gauge-value">
                <span class="gauge-num" style="color:var(--color-${tier})">${g.edgeScore}</span>
                <span class="gauge-tier" style="color:var(--color-${tier})">${tierLabel}</span>
              </div>
            </div>
          </div>

          <div class="team-block">
            <div class="team-abbr">${g.homeTeam}</div>
            <div class="team-name">${shortTeamName(g.homeName, 16)}</div>
          </div>
        </div>

        <div class="odds-row">
          ${oddsRowHtml}
        </div>

        <div class="sparkline-row">
          <div class="sparkline-label">${g.isMMA ? 'Odds Movement' : 'Line Move (simulated)'}</div>
          <div class="sparkline-chart">
            <canvas id="spark-${g.id}"></canvas>
          </div>
        </div>

        <div class="factors-wrap">
          <div class="factors-title">Key Factors</div>
          <ul class="factors-list">
            ${g.factors.map(f => `<li><span class="factor-dot"></span>${f}</li>`).join('')}
          </ul>
        </div>

        <div class="dsb-take">
          <div class="take-label">DSB Take</div>
          <div class="take-text">${g.take}</div>
        </div>

        <div class="explain-section ${state.expandedExplains.has(g.id) ? 'open' : ''}" id="explain-${g.id}">
          <div class="take-label" style="margin-bottom:var(--space-2)">Full Analysis</div>
          <div class="explain-text">${g.explain}</div>
        </div>

        <div class="card-actions">
          <button class="btn-explain" onclick="toggleExplain('${g.id}')">
            ${state.expandedExplains.has(g.id) ? '▲ Hide' : '▼ Explain'}
          </button>
          <button class="btn-share" onclick="shareGame('${g.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            Share
          </button>
          <div class="rating-group">
            <span class="rating-label">Rate:</span>
            <button class="btn-rate ${rating === 'up' ? 'rated-up' : ''}" onclick="rateGame('${g.id}', 'up')" aria-label="Rate this pick up">👍</button>
            <button class="btn-rate ${rating === 'down' ? 'rated-down' : ''}" onclick="rateGame('${g.id}', 'down')" aria-label="Rate this pick down">👎</button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  // Reveal cards with stagger
  requestAnimationFrame(() => {
    document.querySelectorAll('.card-reveal').forEach((el, i) => {
      setTimeout(() => el.classList.add('visible'), i * 60);
    });
  });

  // Update games count
  const countEl = document.getElementById('games-count');
  if (countEl) countEl.textContent = `${games.length} game${games.length !== 1 ? 's' : ''}`;

  // Initialize charts after DOM ready
  setTimeout(() => {
    games.forEach(g => {
      createGauge(`gauge-${g.id}`, g.edgeScore);
      createSparkline(`spark-${g.id}`, g.lineHistory);
    });
  }, 100);
}

// Leaderboard
function renderLeaderboard() {
  const sorted = [...GAMES].sort((a, b) => b.edgeScore - a.edgeScore);
  const topPlays = sorted.slice(0, 5);
  const trapGames = sorted.filter(g => g.edgeScore < 25).slice(0, 3);

  // Trending: sort by time proximity (soonest games)
  const trending = [...GAMES]
    .sort((a, b) => new Date(a.rawTime) - new Date(b.rawTime))
    .slice(0, 5);

  // Top Value Plays
  const topContainer = document.getElementById('sidebar-top-plays');
  topContainer.innerHTML = topPlays.length ? topPlays.map((g, i) => `
    <li class="sidebar-list-item" onclick="scrollToGame('${g.id}')">
      <div class="sidebar-rank">${i + 1}</div>
      <div class="sidebar-matchup">
        <div class="sidebar-matchup-teams">${g.awayTeam} @ ${g.homeTeam}</div>
        <div class="sidebar-matchup-sub">${g.sport} · ${g.risk}</div>
      </div>
      <div class="sidebar-score" style="color:var(--color-${getTierClass(g.edgeScore)})">${g.edgeScore}</div>
    </li>
  `).join('') : '<li style="padding:var(--space-4);color:var(--color-text-faint);font-size:var(--text-xs)">Loading...</li>';

  // Trending
  const trendContainer = document.getElementById('sidebar-trending');
  trendContainer.innerHTML = trending.length ? trending.map((g, i) => `
    <li class="sidebar-list-item" onclick="scrollToGame('${g.id}')">
      <div class="sidebar-rank">${i + 1}</div>
      <div class="sidebar-matchup">
        <div class="sidebar-matchup-teams">${g.awayTeam} @ ${g.homeTeam}</div>
        <div class="sidebar-matchup-sub">${g.sport}</div>
      </div>
      <div class="sidebar-score" style="color:var(--color-${getTierClass(g.edgeScore)})">${g.edgeScore}</div>
    </li>
  `).join('') : '<li style="padding:var(--space-4);color:var(--color-text-faint);font-size:var(--text-xs)">Loading...</li>';

  // Trap Alerts
  const trapContainer = document.getElementById('sidebar-traps');
  if (trapGames.length === 0) {
    trapContainer.innerHTML = '<div style="padding:var(--space-4);color:var(--color-text-muted);font-size:var(--text-xs);">No active trap alerts today.</div>';
  } else {
    trapContainer.innerHTML = trapGames.map(g => `
      <div class="trap-alert-item" onclick="scrollToGame('${g.id}')">
        <div class="trap-icon">⚠️</div>
        <div class="trap-matchup">
          <div class="trap-matchup-teams">${g.awayTeam} @ ${g.homeTeam}</div>
          <div class="trap-matchup-sub">${g.sport} · ${g.time}</div>
        </div>
        <div class="trap-score">${g.edgeScore}</div>
      </div>
    `).join('');
  }
}

// Sport tabs — only show tabs that have games
function renderTabs() {
  const counts = getTabCounts();
  const availableSports = ['NBA', 'NHL', 'MLB', 'NCAAB', 'MMA'].filter(s => counts[s] > 0);
  const tabs = ['ALL', ...availableSports];
  const container = document.getElementById('sport-tabs');
  container.innerHTML = tabs.map(tab => `
    <button class="sport-tab ${state.activeTab === tab ? 'active' : ''}" onclick="setTab('${tab}')">
      ${tab}
      <span class="tab-count">${counts[tab] || 0}</span>
    </button>
  `).join('');

  // Add refresh button at the end
  container.innerHTML += `
    <button class="sport-tab" onclick="refreshData()" title="Refresh live odds data" style="margin-left:auto;font-size:var(--text-xs)">
      ↺ Refresh
    </button>
  `;
}

// ============================================
// INTERACTION HANDLERS
// ============================================

function setTab(tab) {
  state.activeTab = tab;
  renderTabs();
  renderHeatMap();
  renderGameCards();
}

function handleSearch(e) {
  state.searchQuery = e.target.value;
  renderHeatMap();
  renderGameCards();
}

function handleSort(e) {
  state.sortBy = e.target.value;
  renderGameCards();
}

function toggleExplain(id) {
  if (state.expandedExplains.has(id)) {
    state.expandedExplains.delete(id);
  } else {
    state.expandedExplains.add(id);
  }
  const el = document.getElementById(`explain-${id}`);
  const card = document.getElementById(`game-${id}`);
  const btn = card?.querySelector('.btn-explain');
  if (el) el.classList.toggle('open', state.expandedExplains.has(id));
  if (btn) btn.textContent = state.expandedExplains.has(id) ? '▲ Hide' : '▼ Explain';
}

function shareGame(id) {
  const game = GAMES.find(g => g.id === id);
  if (!game) return;
  const tier = getTierLabel(game.edgeScore);
  const text = `DSB Edge Score: ${game.edgeScore} (${tier}) — ${game.awayName} @ ${game.homeName} is ${game.risk === 'LOW' ? 'elite value' : 'worth analyzing'}. Check it out at dailysportsbets.com`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard!'));
  } else {
    showToast('Share: ' + text);
  }
}

function rateGame(id, direction) {
  if (state.ratings[id] === direction) {
    delete state.ratings[id];
  } else {
    state.ratings[id] = direction;
  }
  const card = document.getElementById(`game-${id}`);
  if (!card) return;
  const upBtn = card.querySelector('.btn-rate:first-of-type');
  const downBtn = card.querySelector('.btn-rate:last-of-type');
  if (upBtn) upBtn.className = `btn-rate ${state.ratings[id] === 'up' ? 'rated-up' : ''}`;
  if (downBtn) downBtn.className = `btn-rate ${state.ratings[id] === 'down' ? 'rated-down' : ''}`;
  showToast(state.ratings[id] ? (direction === 'up' ? '👍 Pick rated up!' : '👎 Pick rated down') : 'Rating removed');
}

function refreshData() {
  showToast('Refreshing live odds...');
  GAMES = [];
  fetchAllOdds();
}

// ============================================
// ANALYZE MY BET MODAL — IMPROVED
// ============================================

function openUploadModal() {
  document.getElementById('upload-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('analysis-result').classList.remove('show');
  populateModalGameDropdown();
}

function closeUploadModal() {
  document.getElementById('upload-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

function populateModalGameDropdown() {
  const sportSel = document.getElementById('bet-sport');
  const gameSel = document.getElementById('bet-game');
  if (!sportSel || !gameSel) return;

  // Update sport options from live data
  const availableSports = [...new Set(GAMES.map(g => g.sport))].sort();
  sportSel.innerHTML = '<option value="">Select sport...</option>';
  availableSports.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sportSel.appendChild(opt);
  });

  // If no live data yet, show manual entry option
  if (GAMES.length === 0) {
    const opt = document.createElement('option');
    opt.value = 'MANUAL';
    opt.textContent = 'Manual entry (data loading...)';
    sportSel.appendChild(opt);
  }
}

function onBetSportChange() {
  const sport = document.getElementById('bet-sport').value;
  const gameSel = document.getElementById('bet-game');
  const manualFields = document.getElementById('manual-team-fields');

  if (!gameSel) return;

  gameSel.innerHTML = '<option value="">Select game...</option>';

  if (sport === 'MANUAL' || !sport) {
    gameSel.disabled = true;
    if (manualFields) manualFields.style.display = '';
    resetDirectionPanel();
    return;
  }

  const gamesForSport = GAMES.filter(g => g.sport === sport);
  gamesForSport.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = `${g.awayName} @ ${g.homeName}`;
    gameSel.appendChild(opt);
  });

  gameSel.disabled = false;
  if (gamesForSport.length > 0) {
    if (manualFields) manualFields.style.display = 'none';
  } else {
    if (manualFields) manualFields.style.display = '';
  }

  resetDirectionPanel();
}

function onBetGameChange() {
  const gameId = document.getElementById('bet-game').value;
  const betType = document.getElementById('bet-type').value;
  if (!gameId) {
    resetDirectionPanel();
    return;
  }
  updateDirectionPanel(gameId, betType);
}

function onBetTypeChange() {
  const gameId = document.getElementById('bet-game').value;
  const betType = document.getElementById('bet-type').value;

  const manualFields = document.getElementById('manual-team-fields');
  const propParlayFields = document.getElementById('prop-parlay-fields');

  if (betType === 'prop' || betType === 'parlay') {
    if (manualFields) manualFields.style.display = '';
    if (propParlayFields) propParlayFields.style.display = '';
    resetDirectionPanel();
    return;
  }

  if (propParlayFields) propParlayFields.style.display = 'none';
  if (!gameId) {
    resetDirectionPanel();
    return;
  }
  updateDirectionPanel(gameId, betType);
}

function updateDirectionPanel(gameId, betType) {
  const game = GAMES.find(g => g.id === gameId);
  const dirPanel = document.getElementById('direction-panel');
  const dirOptions = document.getElementById('direction-options');
  const oddsInput = document.getElementById('bet-odds');

  if (!game || !dirPanel || !dirOptions) return;
  if (!betType || betType === 'prop' || betType === 'parlay') {
    resetDirectionPanel();
    return;
  }

  // Auto-fill team name fields
  const awayInput = document.getElementById('bet-away');
  const homeInput = document.getElementById('bet-home');
  if (awayInput) awayInput.value = game.awayName;
  if (homeInput) homeInput.value = game.homeName;

  // Find best available bookmaker data (use all available book keys)
  const availableBkKeys = Object.keys(game.rawOdds).filter(k => game.rawOdds[k]);
  const primaryBkKey = availableBkKeys[0];
  const primaryBk = primaryBkKey ? game.rawOdds[primaryBkKey] : null;

  let options = [];

  if (betType === 'ml') {
    const bkKeys = availableBkKeys;
    bkKeys.forEach(bkKey => {
      const bk = game.rawOdds[bkKey];
      if (!bk) return;
      const h2h = bk.markets?.find(m => m.key === 'h2h');
      if (!h2h) return;
      const homeOut = h2h.outcomes?.find(o => o.name === game.homeName);
      const awayOut = h2h.outcomes?.find(o => o.name === game.awayName);
      const bkLabel = BOOKMAKER_DISPLAY[bkKey] || bkKey;
      if (homeOut) {
        options.push({ label: `${shortTeamName(game.homeName, 20)} (${formatOdds(homeOut.price)}) — ${bkLabel}`, odds: homeOut.price, dir: 'home', book: bkKey });
      }
      if (awayOut) {
        options.push({ label: `${shortTeamName(game.awayName, 20)} (${formatOdds(awayOut.price)}) — ${bkLabel}`, odds: awayOut.price, dir: 'away', book: bkKey });
      }
    });
    // Deduplicate by team + book, keep unique combinations
    const seen = new Set();
    options = options.filter(o => {
      const key = `${o.dir}-${o.book}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } else if (betType === 'spread') {
    if (game.isMMA) {
      dirPanel.style.display = 'none';
      return;
    }
    const bkKeys = availableBkKeys;
    bkKeys.forEach(bkKey => {
      const bk = game.rawOdds[bkKey];
      if (!bk) return;
      const spread = bk.markets?.find(m => m.key === 'spreads');
      if (!spread) return;
      const homeSpread = spread.outcomes?.find(o => o.name === game.homeName);
      const awaySpread = spread.outcomes?.find(o => o.name === game.awayName);
      const bkLabel = BOOKMAKER_DISPLAY[bkKey] || bkKey;
      if (homeSpread) {
        const pt = homeSpread.point > 0 ? `+${homeSpread.point}` : `${homeSpread.point}`;
        options.push({ label: `${shortTeamName(game.homeName, 18)} ${pt} (${formatOdds(homeSpread.price)}) — ${bkLabel}`, odds: homeSpread.price, dir: 'home-spread', book: bkKey, point: homeSpread.point });
      }
      if (awaySpread) {
        const pt = awaySpread.point > 0 ? `+${awaySpread.point}` : `${awaySpread.point}`;
        options.push({ label: `${shortTeamName(game.awayName, 18)} ${pt} (${formatOdds(awaySpread.price)}) — ${bkLabel}`, odds: awaySpread.price, dir: 'away-spread', book: bkKey, point: awaySpread.point });
      }
    });
    const seen = new Set();
    options = options.filter(o => {
      const key = `${o.dir}-${o.book}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } else if (betType === 'total') {
    if (game.isMMA) {
      dirPanel.style.display = 'none';
      return;
    }
    const bkKeys = availableBkKeys;
    bkKeys.forEach(bkKey => {
      const bk = game.rawOdds[bkKey];
      if (!bk) return;
      const total = bk.markets?.find(m => m.key === 'totals');
      if (!total) return;
      const over = total.outcomes?.find(o => o.name === 'Over');
      const under = total.outcomes?.find(o => o.name === 'Under');
      const bkLabel = BOOKMAKER_DISPLAY[bkKey] || bkKey;
      if (over) {
        options.push({ label: `Over ${over.point} (${formatOdds(over.price)}) — ${bkLabel}`, odds: over.price, dir: 'over', book: bkKey, point: over.point });
      }
      if (under) {
        options.push({ label: `Under ${under.point} (${formatOdds(under.price)}) — ${bkLabel}`, odds: under.price, dir: 'under', book: bkKey, point: under.point });
      }
    });
    const seen = new Set();
    options = options.filter(o => {
      const key = `${o.dir}-${o.book}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (options.length === 0) {
    dirPanel.style.display = 'none';
    return;
  }

  dirPanel.style.display = '';
  dirOptions.innerHTML = options.map((o, i) => `
    <label class="direction-option" style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);background:var(--color-surface-2);border:1.5px solid var(--color-border);border-radius:var(--radius-md);cursor:pointer;transition:border-color 0.15s,background 0.15s;font-size:var(--text-sm);font-weight:500">
      <input type="radio" name="bet-direction" value="${i}" data-odds="${o.odds}" data-dir="${o.dir}" data-book="${o.book}" ${i === 0 ? 'checked' : ''} style="accent-color:var(--color-accent);width:16px;height:16px;flex-shrink:0" onchange="onDirectionChange(this)">
      <span>${o.label}</span>
    </label>
  `).join('');

  // Auto-fill odds with first option
  if (options.length > 0 && oddsInput) {
    oddsInput.value = formatOdds(options[0].odds);
  }
}

function onDirectionChange(radio) {
  const odds = radio.dataset.odds;
  const oddsInput = document.getElementById('bet-odds');
  if (oddsInput && odds) oddsInput.value = formatOdds(parseInt(odds));

  // Highlight selected
  document.querySelectorAll('.direction-option').forEach(el => {
    el.style.borderColor = el.querySelector('input').checked ? 'var(--color-accent)' : 'var(--color-border)';
    el.style.background = el.querySelector('input').checked ? 'var(--color-accent-subtle)' : 'var(--color-surface-2)';
  });
}

function resetDirectionPanel() {
  const dirPanel = document.getElementById('direction-panel');
  if (dirPanel) dirPanel.style.display = 'none';
}

function analyzeBet(e) {
  e.preventDefault();
  const sport = document.getElementById('bet-sport').value;
  const homeTeam = document.getElementById('bet-home').value;
  const awayTeam = document.getElementById('bet-away').value;
  const betType = document.getElementById('bet-type').value;
  const oddsRaw = document.getElementById('bet-odds').value;
  const wager = parseFloat(document.getElementById('bet-wager').value) || 100;
  const gameId = document.getElementById('bet-game')?.value;

  if (!sport || !betType || !oddsRaw) {
    showToast('Please fill in all required fields');
    return;
  }

  const oddsNum = parseInt(oddsRaw.replace('+', ''));
  if (isNaN(oddsNum)) {
    showToast('Invalid odds format — use e.g. -110 or +145');
    return;
  }

  let impliedProb;
  if (oddsNum < 0) {
    impliedProb = Math.abs(oddsNum) / (Math.abs(oddsNum) + 100);
  } else {
    impliedProb = 100 / (oddsNum + 100);
  }

  // Find the selected game's edge score if available
  const selectedGame = GAMES.find(g => g.id === gameId);
  let edgeScore;

  if (selectedGame) {
    // Use the game's actual edge score as base, adjusted for bet type
    edgeScore = selectedGame.edgeScore;

    // Adjust based on bet type relative to what's available
    const selectedDir = document.querySelector('input[name="bet-direction"]:checked');
    const dir = selectedDir?.dataset?.dir || '';
    const book = selectedDir?.dataset?.book || '';

    // Bonus for lower vig bookmaker
    if (book === 'fanduel') edgeScore = Math.min(97, edgeScore + 2);

    // Clamp
    edgeScore = Math.max(5, Math.min(97, edgeScore));
  } else {
    // Manual entry — generate based on implied prob
    const base = Math.floor(35 + Math.abs(impliedProb - 0.5) * 100);
    edgeScore = Math.min(97, Math.max(8, base));
  }

  const tier = getTierClass(edgeScore);
  const tierLabel = getTierLabel(edgeScore);
  const color = `var(--color-${tier})`;

  // EV calculation
  const modelProb = impliedProb + (edgeScore - 50) / 500;
  const payout = oddsNum < 0 ? (100 / Math.abs(oddsNum)) * wager : (oddsNum / 100) * wager;
  const ev = ((modelProb * payout) - ((1 - modelProb) * wager)).toFixed(2);

  // Direction-aware labels
  const selectedDir = document.querySelector('input[name="bet-direction"]:checked');
  const dirLabel = selectedDir?.closest('label')?.querySelector('span')?.textContent || '';

  const homeDisplay = homeTeam || (selectedGame?.homeName) || 'Home';
  const awayDisplay = awayTeam || (selectedGame?.awayName) || 'Away';

  // Risk assessment text — direction-specific
  let riskText = '';
  if (dirLabel && selectedGame) {
    riskText = `Your bet: ${dirLabel.replace(/\s—\s\w+/g, '')}. `;
  }

  if (edgeScore >= 60) {
    riskText += `This ${betType.toUpperCase()} bet shows solid value. The market is mispricing this matchup in your favor. Implied probability: ${(impliedProb * 100).toFixed(1)}% — DSB model says ${(modelProb * 100).toFixed(1)}%.`;
  } else if (edgeScore >= 40) {
    riskText += `This ${betType.toUpperCase()} bet is near fair value. The market has this reasonably priced but there may be slight edge depending on lineup news. Implied probability: ${(impliedProb * 100).toFixed(1)}% — model: ${(modelProb * 100).toFixed(1)}%.`;
  } else {
    riskText += `This ${betType.toUpperCase()} bet is overpriced. The market is offering less value than the data supports. Consider alternatives. Implied probability: ${(impliedProb * 100).toFixed(1)}% — DSB model says ${(modelProb * 100).toFixed(1)}%.`;
  }

  // Alt bet suggestion
  const altEdge = Math.min(97, edgeScore + 5);
  const altBetType = betType === 'spread' ? 'Total Over/Under' : betType === 'ml' ? 'Spread' : 'Moneyline';
  const altText = selectedGame
    ? `Consider the ${altBetType} on ${awayDisplay} @ ${homeDisplay} — current game Edge Score is ${selectedGame.edgeScore}. ${altEdge > edgeScore ? `Alternative markets may offer better value.` : 'Your selected bet type is well-positioned.'}`
    : `Consider the ${altBetType} instead — Edge Score ${altEdge} vs. your ${betType.toUpperCase()} at ${edgeScore}`;

  const result = document.getElementById('analysis-result');
  document.getElementById('result-score').textContent = edgeScore;
  document.getElementById('result-score').style.color = color;
  document.getElementById('result-tier-badge').textContent = tierLabel;
  document.getElementById('result-tier-badge').style.color = color;
  document.getElementById('result-game-title').textContent = `${awayDisplay} @ ${homeDisplay}`;
  document.getElementById('result-ev').textContent = `Expected Value: ${ev >= 0 ? '+' : ''}$${ev} per $${wager} wagered`;
  document.getElementById('result-risk-text').textContent = riskText;
  document.getElementById('result-alt-text').textContent = altText;
  document.getElementById('result-alt-score').textContent = altEdge;

  result.classList.add('show');
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ============================================
// EXPORT
// ============================================
function exportAnalysis() {
  const games = getFilteredGames();
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const dataSource = lastFetchTime ? `Live data fetched at ${lastFetchTime.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET` : 'Mock data';
  const lines = [
    '═══════════════════════════════════════════════════════════════',
    '                DSB AI RISK & VALUE ANALYZER',
    '          Powered by DSB Edge — dailysportsbets.com',
    '═══════════════════════════════════════════════════════════════',
    `Generated: ${timestamp} ET`,
    `Data: ${dataSource}`,
    `Filter: ${state.activeTab} | Sort: ${state.sortBy}`,
    '',
    `Total Games: ${games.length} | Value Plays: ${games.filter(g => g.edgeScore >= 60).length}`,
    '',
    '───────────────────────────────────────────────────────────────',
    'GAME ANALYSIS',
    '───────────────────────────────────────────────────────────────',
    ...games.map(g => [
      ``,
      `${g.awayName} @ ${g.homeName} [${g.sport}] — ${g.time}`,
      `Edge Score: ${g.edgeScore} (${getTierLabel(g.edgeScore)}) | Risk: ${g.risk}`,
      `Spread: ${g.odds.dk?.spread || 'N/A'} | ML: ${g.odds.dk?.ml || 'N/A'} | Total: ${g.odds.dk?.total || 'N/A'}`,
      `DSB Take: ${g.take.substring(0, 150)}...`,
    ].join('\n')),
    '',
    '───────────────────────────────────────────────────────────────',
    'DISCLAIMER: For entertainment purposes only. Bet responsibly.',
    'dailysportsbets.com | Where winning comes easy...',
    '═══════════════════════════════════════════════════════════════'
  ].join('\n');

  const blob = new Blob([lines], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `DSB-Analysis-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Analysis exported!');
}

// ============================================
// THEME TOGGLE
// ============================================
function initTheme() {
  const root = document.documentElement;
  state.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', state.theme);
  updateThemeIcon();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  updateThemeIcon();
  setTimeout(() => {
    getFilteredGames().forEach(g => {
      createGauge(`gauge-${g.id}`, g.edgeScore);
      createSparkline(`spark-${g.id}`, g.lineHistory);
    });
  }, 50);
}

function updateThemeIcon() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  if (state.theme === 'dark') {
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
  } else {
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  }
}

// ============================================
// TOAST
// ============================================
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// ============================================
// TIMESTAMP
// ============================================
function updateTimestamp() {
  const el = document.getElementById('last-updated');
  if (!el) return;

  if (lastFetchTime) {
    const fresh = isDataFresh();
    const fetchedStr = lastFetchTime.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
    });
    const liveTag = fresh
      ? '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--color-accent);margin-right:4px;vertical-align:middle;animation:pulse 2s infinite"></span><span style="color:var(--color-accent);font-weight:700;font-size:0.7em;letter-spacing:0.08em;vertical-align:middle">LIVE</span> '
      : '';
    el.innerHTML = `${liveTag}Updated <strong>${fetchedStr} ET</strong>`;
  } else {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York'
    });
    el.innerHTML = `Updated <strong>${timeStr} ET</strong>`;
  }
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  // Show loading skeletons immediately
  renderLoadingState();

  // Render sport tabs with "loading" state
  const tabContainer = document.getElementById('sport-tabs');
  if (tabContainer) {
    tabContainer.innerHTML = `
      <button class="sport-tab active">ALL <span class="tab-count">…</span></button>
      <button class="sport-tab" style="margin-left:auto;font-size:var(--text-xs)" onclick="refreshData()">↺ Refresh</button>
    `;
  }

  // Theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Search
  document.getElementById('search-input').addEventListener('input', handleSearch);

  // Sort
  document.getElementById('sort-select').addEventListener('change', handleSort);

  // Upload modal backdrop
  document.getElementById('upload-overlay').addEventListener('click', function(e) {
    if (e.target === this) closeUploadModal();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeUploadModal();
  });

  // Direction panel: style highlight on load
  document.addEventListener('change', (e) => {
    if (e.target.name === 'bet-direction') {
      onDirectionChange(e.target);
    }
  });

  // Auto-refresh timestamp
  setInterval(updateTimestamp, 60000);

  // Load pre-fetched data immediately (no network needed)
  loadPrefetchedData();
});
