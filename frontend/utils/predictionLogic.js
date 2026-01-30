import { COLORS } from '../constants/colors';

/**
 * Core Prediction Logic used by both TipsScreen and MatchDetailsScreen.
 * Ensures consistency across the app.
 * 
 * @param {Object} params
 * @param {string} params.homeName
 * @param {string} params.awayName
 * @param {Object} params.homeStats - { record (string), lastMatches (array, optional), leagueStats (optional) }
 * @param {Object} params.awayStats - { record (string), lastMatches (array, optional), leagueStats (optional) }
 * @param {Object} params.h2h - { homeWins, awayWins, draws, recent (array) } (optional)
 * @param {string} params.sport - 'soccer' | 'basketball'
 * @param {boolean} params.isDetailed - If true, assumes detailed analysis (MatchDetails); if false, uses simplified logic (Tips)
 */
export const analyzeMatch = ({
    homeName,
    awayName,
    homeStats,
    awayStats,
    h2h = null,
    sport,
    isDetailed = false
}) => {
    const factors = [];
    let homeScore = 0;
    let awayScore = 0;
    
    // Team Totals (Declared here to ensure scope access)
    let homeTeamTotalPrediction = null;
    let homeTeamTotalConfidence = 0;
    let awayTeamTotalPrediction = null;
    let awayTeamTotalConfidence = 0;
    
    // --- Helper: Parse Record (e.g., "10-5-2") ---
    const parseRecord = (record) => {
        if (!record) return { w: 0, l: 0, d: 0, played: 0, winPct: 0 };
        const parts = record.split(/[-–]/).map(s => parseInt(s, 10));
        let w = 0, l = 0, d = 0;
        
        if (sport === 'basketball' && parts.length >= 2) { 
            w = parts[0]; l = parts[1]; 
        } else if (parts.length === 3) { 
            w = parts[0]; d = parts[1]; l = parts[2]; 
        } else if (parts.length === 2) { 
            w = parts[0]; l = parts[1]; 
        }
        
        const played = w + l + d;
        return { w, l, d, played, winPct: played ? (w/played)*100 : 0 };
    };

    const homeRecord = parseRecord(homeStats.record);
    const awayRecord = parseRecord(awayStats.record);

    // --- 1. Team Strength (Base on Record) ---
    // Weight: 35% (Unified weight for consistency)
    const recordWeight = 35;
    
    if (homeRecord.winPct > awayRecord.winPct + 15) {
        homeScore += recordWeight;
        factors.push({ label: "Better Season Record", side: "home", type: "success" });
    } else if (awayRecord.winPct > homeRecord.winPct + 15) {
        awayScore += recordWeight;
        factors.push({ label: "Better Season Record", side: "away", type: "success" });
    }

    // --- 2. Form Analysis (Last 5 matches) ---
    // Try to use detailed lastMatches first, fallback to simple form string if available
    let homeFormPts = 0;
    let awayFormPts = 0;
    let hasForm = false;

    if (homeStats.lastMatches && awayStats.lastMatches) {
        const getFormPoints = (matches) => {
            if (!matches) return 0;
            return matches.reduce((acc, m) => acc + (m.result === 'W' ? 3 : (m.result === 'D' ? 1 : 0)), 0);
        };
        homeFormPts = getFormPoints(homeStats.lastMatches);
        awayFormPts = getFormPoints(awayStats.lastMatches);
        hasForm = true;
    } else if (homeStats.form && awayStats.form) {
        // Fallback: Parse simple form string (e.g. "W-L-D-W-W" or "W5")
        // Note: ESPN form might be "W5" (Streak) or full string.
        // Assuming streak like "W5", "L2".
        // If it is a string like "W5", we can just give points.
        const parseStreak = (s) => {
             if (!s) return 0;
             const type = s.charAt(0); // W, L, D
             const count = parseInt(s.substring(1)) || 1;
             if (type === 'W') return count * 3;
             if (type === 'D') return count * 1;
             return 0; // L
        };
        homeFormPts = parseStreak(homeStats.form);
        awayFormPts = parseStreak(awayStats.form);
        hasForm = true;
    }

    if (hasForm) {
        // Weight: 20% (Reduced from 30 to prevent flipping Record prediction too easily)
        if (homeFormPts > awayFormPts + 3) {
            homeScore += 20;
            factors.push({ label: "Better Recent Form", side: "home", type: "success" });
        } else if (awayFormPts > homeFormPts + 3) {
            awayScore += 20;
            factors.push({ label: "Better Recent Form", side: "away", type: "success" });
        } else {
            factors.push({ label: "Similar Recent Form", side: "neutral", type: "info" });
        }
    } else {
        // If no form, we can't award points, but we shouldn't penalize.
        // The 35 points from record become the main driver.
    }

    // --- 3. Head to Head ---
    let h2hAvgGoals = 0;
    let h2hMaxPoints = 0;
    let h2hMinPoints = 1000;

    if (h2h) {
        const totalMeetings = h2h.homeWins + h2h.awayWins + h2h.draws;
        if (totalMeetings > 0) {
            // Weight: 15% (Reduced from 20)
            const hWinPct = (h2h.homeWins / totalMeetings) * 100;
            const aWinPct = (h2h.awayWins / totalMeetings) * 100;
            
            if (hWinPct > 50) {
                homeScore += 15;
                factors.push({ label: "Dominates H2H", side: "home", type: "success" });
            } else if (aWinPct > 50) {
                awayScore += 15;
                factors.push({ label: "Dominates H2H", side: "away", type: "success" });
            }
        }

        // Detailed H2H Analysis (Goals & recent trends)
        if (h2h.recent && h2h.recent.length > 0) {
            let totalGoals = 0;
            let hGoals = 0;
            let aGoals = 0;
            let validGames = 0;

            h2h.recent.forEach(game => {
                // Parse score "2-1" or "100-98"
                // Assuming score format matches what is passed from MatchDetailsScreen
                if (game.score && game.score.includes('-')) {
                    const parts = game.score.split('-').map(s => parseInt(s, 10));
                    if (!isNaN(parts[0]) && !isNaN(parts[1])) {
                         // Note: We need to know who was home/away in that specific match to assign hGoals/aGoals correctly relative to CURRENT teams.
                         // However, MatchDetails logic already sorted wins/losses. 
                         // For goal totals, it doesn't matter who scored.
                         const gameTotal = parts[0] + parts[1];
                         totalGoals += gameTotal;
                         if (gameTotal > h2hMaxPoints) h2hMaxPoints = gameTotal;
                         if (gameTotal < h2hMinPoints) h2hMinPoints = gameTotal;
                         validGames++;
                    }
                }
            });

            if (validGames > 0) {
                h2hAvgGoals = totalGoals / validGames;
                const label = sport === 'basketball' ? 'Points' : 'Goals';
                
                if (sport !== 'basketball') {
                    if (h2hAvgGoals > 2.8) {
                        factors.push({ label: `H2H Avg > 2.8 ${label}`, side: "neutral", type: "info" });
                    } else if (h2hAvgGoals < 1.8) {
                        factors.push({ label: `H2H Avg < 1.8 ${label}`, side: "neutral", type: "info" });
                    }
                } else {
                     if (h2hAvgGoals > 225) {
                        factors.push({ label: `H2H Avg > 225 ${label}`, side: "neutral", type: "info" });
                    }
                }
            }
        }
        
        // Deep Stats (Corners/Cards) - Only if provided
        if (h2h.deepStats) {
             // ... (Simplified for shared logic, can be expanded if passed)
        }
    }

    // --- 4. Goal Analysis ---
    let hAvgScored = 0, aAvgScored = 0;
    let hAvgConceded = 0, aAvgConceded = 0;
    let hLastGamePts = 0, aLastGamePts = 0;

    if (homeStats.lastMatches && awayStats.lastMatches) {
        const calcAvg = (matches, key) => matches.reduce((sum, m) => sum + (m[key] || 0), 0) / matches.length;
        hAvgScored = calcAvg(homeStats.lastMatches, 'pf');
        aAvgScored = calcAvg(awayStats.lastMatches, 'pf');
        hAvgConceded = calcAvg(homeStats.lastMatches, 'pa');
        aAvgConceded = calcAvg(awayStats.lastMatches, 'pa');

        // Extract Last Game Total Points
        if (homeStats.lastMatches.length > 0) {
            const last = homeStats.lastMatches[0];
            hLastGamePts = (parseFloat(last.pf) || 0) + (parseFloat(last.pa) || 0);
        }
        if (awayStats.lastMatches.length > 0) {
            const last = awayStats.lastMatches[0];
            aLastGamePts = (parseFloat(last.pf) || 0) + (parseFloat(last.pa) || 0);
        }
    } else {
        // Fallback estimate from record if possible, or skip
        // Without detailed scores, we can't do accurate Over/Under
    }

    if (hAvgScored > 0 && aAvgScored > 0) {
         if (hAvgScored > aAvgScored + 0.5) {
            homeScore += 15;
            factors.push({ label: `High Scoring (${hAvgScored.toFixed(1)} avg)`, side: "home", type: "info" });
        } else if (aAvgScored > hAvgScored + 0.5) {
            awayScore += 15;
            factors.push({ label: `High Scoring (${aAvgScored.toFixed(1)} avg)`, side: "away", type: "info" });
        }
    }

    // --- 5. News / Injuries ---
    if (homeStats.news && awayStats.news) {
        const checkNews = (news) => {
            if (!news) return false;
            const keywords = ['injury', 'injured', 'out', 'miss', 'suspended', 'surgery'];
            return news.some(n => keywords.some(k => n.headline.toLowerCase().includes(k) || n.description?.toLowerCase().includes(k)));
        };

        if (checkNews(homeStats.news)) {
            homeScore -= 15;
            factors.push({ label: "Roster Issues", side: "home", type: "error" });
        }
        if (checkNews(awayStats.news)) {
            awayScore -= 15;
            factors.push({ label: "Roster Issues", side: "away", type: "error" });
        }
    }

    // --- FINAL PREDICTION LOGIC ---
    let prediction = "Draw / Close Match";
    let color = COLORS.textSecondary;
    let finalConfidence = 50;
    
    // Normalize Score Difference
    const diff = homeScore - awayScore;
    const isBasketball = sport === 'basketball';

    // A. Win / Double Chance Logic
    let winPrediction = null;
    let winConfidence = 0;

    if (!isBasketball) {
        if (diff > 25) {
            winPrediction = `${homeName} to Win`;
            winConfidence = Math.min(60 + (diff / 2), 95);
        } else if (diff < -25) {
            winPrediction = `${awayName} to Win`;
            winConfidence = Math.min(60 + (Math.abs(diff) / 2), 95);
        } else if (diff > 10) {
            winPrediction = `1X (Home or Draw)`;
            winConfidence = Math.min(70 + (diff / 2), 90);
        } else if (diff < -10) {
            winPrediction = `X2 (Away or Draw)`;
            winConfidence = Math.min(70 + (Math.abs(diff) / 2), 90);
        } else {
            winPrediction = "Draw / Close Match";
            winConfidence = 50 + Math.abs(diff);
        }
    }

    // B. Goals / Totals Logic (Only if detailed stats available)
    let goalsPrediction = null;
    let goalsConfidence = 0;

    // Shared state for Basketball
    let projectedTotalPoints = 0;
    let projectedMargin = 0;

    if (hAvgScored > 0 && aAvgScored > 0) {
        if (!isBasketball) {
            let expHomeGoals = (hAvgScored + aAvgConceded) / 2;
            let expAwayGoals = (aAvgScored + hAvgConceded) / 2;
            let totalExpGoals = expHomeGoals + expAwayGoals;

            // Adjust based on H2H history if available
            if (h2hAvgGoals > 0) {
                // Blend: 70% Recent Form, 30% H2H History
                totalExpGoals = (totalExpGoals * 0.7) + (h2hAvgGoals * 0.3);
            }

            // --- Enhanced Granular Goal Analysis (1.5 - 5.5) ---
            // Removed 0.5 as it's too safe/trivial and causes inconsistency with Tips
            const thresholds = [1.5, 2.5, 3.5, 4.5, 5.5];
            let bestGoalPred = null;
            let bestGoalConf = 0;

            thresholds.forEach(t => {
                // Over Calculation
                if (totalExpGoals > t + 0.35) { // e.g. > 2.85 for Over 2.5
                    const conf = Math.min(60 + ((totalExpGoals - t) * 30), 95);
                    if (conf > bestGoalConf) {
                        bestGoalConf = conf;
                        bestGoalPred = `Over ${t} Goals`;
                    }
                }
                // Under Calculation
                if (totalExpGoals < t - 0.35) { // e.g. < 2.15 for Under 2.5
                    const conf = Math.min(60 + ((t - totalExpGoals) * 30), 95);
                    if (conf > bestGoalConf) {
                        bestGoalConf = conf;
                        bestGoalPred = `Under ${t} Goals`;
                    }
                }
            });

            // Set Primary Goal Prediction
            if (bestGoalPred) {
                goalsPrediction = bestGoalPred;
                goalsConfidence = bestGoalConf;

                // Add factor for high/low expectancy
                if (totalExpGoals > 2.8) {
                    factors.push({ label: `High Goal Expectancy (${totalExpGoals.toFixed(1)})`, side: "neutral", type: "success" });
                } else if (totalExpGoals < 2.2) {
                    factors.push({ label: `Low Goal Expectancy (${totalExpGoals.toFixed(1)})`, side: "neutral", type: "warning" });
                }
            }
        } else {
            // --- BASKETBALL TOTALS LOGIC ---
            let totalPoints = hAvgScored + aAvgScored; // Base expectation
            
            // Adjust based on H2H history for Basketball
            if (h2hAvgGoals > 0) {
                totalPoints = (totalPoints * 0.6) + (h2hAvgGoals * 0.4);
            }

            // Adjust with recent trend (last game)
            if (hLastGamePts > 0 && aLastGamePts > 0) {
                const recentTrend = (hLastGamePts + aLastGamePts) / 2;
                totalPoints = (totalPoints * 0.8) + (recentTrend * 0.2);
            }

            projectedTotalPoints = totalPoints;

            // Set a "Line" to predict against
            const predictedLine = Math.round(totalPoints);
            
            // Check user constraints: H2H Max/Min and Previous Game
            let confidenceBoost = 0;
            
            if (h2hAvgGoals > 0) {
                // If the LOWEST H2H score is still high, that's a strong Over signal
                if (h2hMinPoints > predictedLine - 10) {
                     confidenceBoost += 5;
                     factors.push({ label: `H2H Floor High (> ${h2hMinPoints})`, side: "neutral", type: "info" });
                }
                // If the HIGHEST H2H score is low, that's a strong Under signal
                if (h2hMaxPoints < predictedLine + 10) {
                     confidenceBoost += 5;
                     factors.push({ label: `H2H Ceiling Low (< ${h2hMaxPoints})`, side: "neutral", type: "info" });
                }
            }

            // Last Game Context
            if (hLastGamePts > 0) {
                if (hLastGamePts > predictedLine / 2 + 10) {
                    factors.push({ label: `${homeName} Last Game High (${hLastGamePts})`, side: "home", type: "info" });
                } else if (hLastGamePts < predictedLine / 2 - 10) {
                    factors.push({ label: `${homeName} Last Game Low (${hLastGamePts})`, side: "home", type: "info" });
                }
            }

            // Generate Prediction Lines
            // Logic: If we project 230, we predict "Over 223.5" (safe margin)
            const margin = 6.5; 
            const overLine = Math.floor(projectedTotalPoints - margin) + 0.5;
            const underLine = Math.ceil(projectedTotalPoints + margin) - 0.5;

            // Determine Over/Under
            if (projectedTotalPoints > 220) {
                goalsPrediction = `Over ${overLine}`;
                goalsConfidence = 70 + confidenceBoost;
                factors.push({ label: `Proj. Total ${predictedLine} Pts`, side: "neutral", type: "success" });
            } else if (projectedTotalPoints < 210) {
                goalsPrediction = `Under ${underLine}`;
                goalsConfidence = 70 + confidenceBoost;
                factors.push({ label: `Proj. Total ${predictedLine} Pts`, side: "neutral", type: "warning" });
            } else {
                // Middle ground
                if (hLastGamePts > projectedTotalPoints/2 && aLastGamePts > projectedTotalPoints/2) {
                     goalsPrediction = `Over ${overLine}`;
                     goalsConfidence = 65;
                     factors.push({ label: "Recent Games High Scoring", side: "neutral", type: "info" });
                } else {
                     goalsPrediction = `Under ${underLine}`;
                     goalsConfidence = 65;
                }
            }
        }
    }

    // --- BASKETBALL SPREAD / HANDICAP LOGIC ---
    // Focuses on Margin of Victory, Home/Away Splits, and Fatigue
    let spreadPrediction = null;
    let spreadConfidence = 0;

    if (isBasketball && homeStats.lastMatches && awayStats.lastMatches) {
        // 1. Calculate Splits (Home at Home, Away at Away)
        const getMargin = (matches) => {
            if (!matches || matches.length === 0) return 0;
            return matches.reduce((sum, m) => sum + (parseInt(m.pf) - parseInt(m.pa)), 0) / matches.length;
        };

        // Filter for splits
        const homeAtHome = homeStats.lastMatches.filter(m => m.isHome);
        const awayAtAway = awayStats.lastMatches.filter(m => !m.isHome);

        // Calculate Ratings (Avg Point Differential)
        // Fallback to overall last 5 if splits are empty (early season)
        const homeRating = homeAtHome.length >= 2 ? getMargin(homeAtHome) : getMargin(homeStats.lastMatches) + 3; // +3 Home Court Proxy
        const awayRating = awayAtAway.length >= 2 ? getMargin(awayAtAway) : getMargin(awayStats.lastMatches) - 3; // -3 Away Disadv Proxy

        // 2. Base Expected Margin
        // If Home is +10 and Away is -5, Exp Margin = +15 (Home wins by 15)
        projectedMargin = homeRating - awayRating;

        // 3. Adjust for Fatigue (Rest Days)
        // Check date of last match
        const checkFatigue = (matches) => {
            if (!matches || matches.length === 0) return false;
            const lastDate = new Date(matches[0].date);
            const today = new Date();
            const diffTime = Math.abs(today - lastDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
            return diffDays <= 2; // Played within last 48 hours (Back-to-back or 1 day rest)
        };

        if (checkFatigue(homeStats.lastMatches)) {
            projectedMargin -= 4; // Fatigue Penalty
            factors.push({ label: "Home Fatigue (Short Rest)", side: "away", type: "warning" });
        }
        if (checkFatigue(awayStats.lastMatches)) {
            projectedMargin += 4; // Fatigue Bonus for Home (Away tired)
            factors.push({ label: "Away Fatigue (Short Rest)", side: "home", type: "success" });
        }

        // 4. H2H Adjustment (20% Weight)
        if (h2h && h2h.recent && h2h.recent.length > 0) {
            let h2hMarginSum = 0;
            let count = 0;
            h2h.recent.forEach(game => {
                 if (game.score && game.score.includes('-')) {
                    const parts = game.score.split('-').map(s => parseInt(s, 10));
                    // Note: We need to ensure we know who is home. 
                    // Assuming standard H-A order in H2H list might be risky without parsing names.
                    // For now, skip specific margin calc from H2H to avoid flipping signs error.
                    // Or rely on h2h.homeWins dominance earlier.
                 }
            });
            // Simplified: If Home dominates H2H (>60% wins), boost margin
            const total = h2h.homeWins + h2h.awayWins;
            if (total > 0) {
                if (h2h.homeWins / total > 0.6) projectedMargin += 3;
                if (h2h.awayWins / total > 0.6) projectedMargin -= 3;
            }
        }

        // 5. Generate Spread Line
        // We output a "Handicap" prediction.
        // e.g. "Lakers -5.5"
        
        // Safety Buffer: We want Value.
        // If we project +10, we recommend -6.5 to be safe.
        // If we project +3, we might skip or recommend ML.
        
        const spreadBuffer = 3.5; 
        
        // DISABLE SPREAD PREDICTION FOR BASKETBALL (User Request: Only Totals or Team Totals)
        // We still calculated projectedMargin above, which is needed for Team Totals.
        /*
        if (projectedMargin > 5) {
            // Home Favorite
            const line = Math.floor(projectedMargin - spreadBuffer) + 0.5; // e.g. 10 -> 6.5
            if (line > 0) {
                spreadPrediction = `${homeName} ${-line}`; // e.g. "Lakers -6.5"
                spreadConfidence = 75; // Baseline high for clear favorites
                factors.push({ label: `Proj. Margin +${Math.round(projectedMargin)}`, side: "home", type: "success" });
            }
        } else if (projectedMargin < -5) {
            // Away Favorite
            const line = Math.floor(Math.abs(projectedMargin) - spreadBuffer) + 0.5;
            if (line > 0) {
                spreadPrediction = `${awayName} ${-line}`; // e.g. "Celtics -6.5"
                spreadConfidence = 75;
                factors.push({ label: `Proj. Margin ${Math.round(projectedMargin)}`, side: "away", type: "success" });
            }
        } else {
            // Close game - Predicting spread is risky without knowing book line.
            // Maybe predict "Cover +X"?
            // Let's stick to Moneyline for close games unless user wants specific spread logic.
            spreadConfidence = 50; 
        }

        // 6. Confidence Boosters
        // Check Consistency (Std Dev proxy: diff between Avg Margin and Last Game Margin)
        // If Last Game Margin is consistent with Avg, boost confidence.
        const homeLastMargin = homeStats.lastMatches.length > 0 ? (parseInt(homeStats.lastMatches[0].pf) - parseInt(homeStats.lastMatches[0].pa)) : 0;
        if (Math.abs(homeLastMargin - homeRating) < 5) spreadConfidence += 5; // Consistent form
        */

        // --- BASKETBALL TEAM TOTALS LOGIC ---
        // Implied Score = (Total + Margin) / 2
        // e.g. Total 220, Home +10. Home = 115, Away = 105.
        
        if (projectedTotalPoints > 0) {
            const impliedHomeScore = (projectedTotalPoints + projectedMargin) / 2;
            const impliedAwayScore = (projectedTotalPoints - projectedMargin) / 2;
            
            const teamTotalBuffer = 4.5; // Safety margin
            
            // Home Team Total Prediction
            const homeLine = Math.floor(impliedHomeScore - teamTotalBuffer) + 0.5;
            if (impliedHomeScore > 100) { // Basic sanity check
                 homeTeamTotalPrediction = `${homeName} Over ${homeLine}`;
                 // Confidence based on how strong the scoring data is
                 homeTeamTotalConfidence = 65; 
                 if (homeStats.lastMatches && homeStats.lastMatches.length > 0) {
                     const avg = homeStats.lastMatches.reduce((s, m) => s + parseInt(m.pf), 0) / homeStats.lastMatches.length;
                     if (avg > homeLine + 5) homeTeamTotalConfidence += 10;
                 }
                 factors.push({ label: `Implied Home Score ${Math.round(impliedHomeScore)}`, side: "home", type: "info" });
            }

            // Away Team Total Prediction
            const awayLine = Math.floor(impliedAwayScore - teamTotalBuffer) + 0.5;
             if (impliedAwayScore > 100) {
                 awayTeamTotalPrediction = `${awayName} Over ${awayLine}`;
                 awayTeamTotalConfidence = 65;
                 if (awayStats.lastMatches && awayStats.lastMatches.length > 0) {
                     const avg = awayStats.lastMatches.reduce((s, m) => s + parseInt(m.pf), 0) / awayStats.lastMatches.length;
                     if (avg > awayLine + 5) awayTeamTotalConfidence += 10;
                 }
                 factors.push({ label: `Implied Away Score ${Math.round(impliedAwayScore)}`, side: "away", type: "info" });
            }
        }
    }

    // C. Select Best Prediction (Highest Confidence Wins)
    // Strategy: Compare all generated predictions and pick the one with the highest confidence score.

    const candidates = [];

    // 1. Win Prediction Candidate
    if (winPrediction) {
        let winColor = COLORS.textSecondary;
        if (winPrediction.includes(homeName)) winColor = COLORS.success;
        else if (winPrediction.includes(awayName)) winColor = COLORS.error;
        else if (winPrediction.includes('1X')) winColor = '#4dabf7'; 
        else if (winPrediction.includes('X2')) winColor = '#ff8787'; 
        
        candidates.push({
            text: winPrediction,
            confidence: winConfidence,
            color: winColor
        });
    }

    // 2. Goals/Total Prediction Candidate
    if (goalsPrediction) {
        candidates.push({
            text: goalsPrediction,
            confidence: goalsConfidence,
            color: COLORS.accent
        });
    }

    // 3. Spread/Handicap Prediction Candidate
    if (spreadPrediction) {
         const spreadColor = spreadPrediction.includes(homeName) ? COLORS.success : COLORS.error;
         candidates.push({
            text: spreadPrediction,
            confidence: spreadConfidence,
            color: spreadColor
         });
    }

    // 4. Team Totals Candidates
    if (homeTeamTotalPrediction) {
        candidates.push({
            text: homeTeamTotalPrediction,
            confidence: homeTeamTotalConfidence,
            color: COLORS.info
        });
    }
    if (awayTeamTotalPrediction) {
        candidates.push({
            text: awayTeamTotalPrediction,
            confidence: awayTeamTotalConfidence,
            color: COLORS.info
        });
    }

    // 4. Sort by confidence (descending)
    // If tie, stable sort preserves order (Win > Goals > Spread priority if needed, but here we trust score)
    // We can add a secondary sort priority if needed, but "highest confidence" is the requested logic.
    candidates.sort((a, b) => b.confidence - a.confidence);

    // 5. Select Best
    const best = candidates[0];
    prediction = best.text;
    finalConfidence = best.confidence;
    color = best.color;

    // Debug log to verify selection logic (optional, for development)
    // console.log("Prediction Candidates:", candidates);


    return {
        prediction,
        confidence: Math.round(finalConfidence),
        color,
        factors
    };
};
