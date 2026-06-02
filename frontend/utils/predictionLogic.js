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
    isDetailed = false,
    mlContext = null // New parameter for ML-based calibration
}) => {
    // --- Advanced Ranking & Scoring Strategy ---
    // 1. Core Statistical Base (homeScore/awayScore)
    // 2. ML Confidence Calibration
    // 3. Multi-Factor Contextual Weighting

    const factors = [];
    let homeScore = 0;
    let awayScore = 0;


    
    // Team Totals (Declared here to ensure scope access)
    let homeTeamTotalPrediction = null;
    let homeTeamTotalConfidence = 0;
    let awayTeamTotalPrediction = null;
    let awayTeamTotalConfidence = 0;
    let cornersPrediction = null;
    let cornersConfidence = 0;
    
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
            factors.push({ label: "Stronger Recent Form", side: "home", type: "success" });
        } else if (awayFormPts > homeFormPts + 3) {
            awayScore += 20;
            factors.push({ label: "Stronger Recent Form", side: "away", type: "success" });
        } else {
            factors.push({ label: "Competitive Recent Form", side: "neutral", type: "info" });
        }

        // Additional Detail: Streaks and Clean Sheets
        const processDetails = (matches, side) => {
            if (!matches || matches.length === 0) return;
            const last3 = matches.slice(0, 3);
            
            // Clean Sheet Check (Soccer)
            if (sport === 'soccer') {
                const cleanSheets = last3.filter(m => m.pa === 0).length;
                if (cleanSheets >= 2) {
                    side === 'home' ? homeScore += 10 : awayScore += 10;
                    factors.push({ label: `Solid Defense (${cleanSheets} Clean Sheets)`, side, type: "success" });
                }

                // Scoring Streak
                const failedToScore = matches.filter(m => m.pf === 0).length;
                if (failedToScore >= 2) {
                    side === 'home' ? homeScore -= 10 : awayScore -= 10;
                    factors.push({ label: "Struggling to Score", side, type: "error" });
                }
            }
        };

        if (isDetailed) {
            processDetails(homeStats.lastMatches, 'home');
            processDetails(awayStats.lastMatches, 'away');

            // Trend check: Improving vs Declining
            const getTrend = (matches) => {
                if (!matches || matches.length < 3) return 0;
                // Sum points of last 2 vs previous 2
                const p = (m) => m.result === 'W' ? 3 : (m.result === 'D' ? 1 : 0);
                return (p(matches[0]) + p(matches[1])) - (p(matches[2]) + (matches[3] ? p(matches[3]) : 1));
            };

            const hTrend = getTrend(homeStats.lastMatches);
            const aTrend = getTrend(awayStats.lastMatches);

            if (hTrend > aTrend + 1) {
                homeScore += 5;
                factors.push({ label: "Upward Performance Trend", side: "home", type: "success" });
            } else if (aTrend > hTrend + 1) {
                awayScore += 5;
                factors.push({ label: "Upward Performance Trend", side: "away", type: "success" });
            }
        }
    } else {
        // ...
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
        if (h2h.deepStats && sport === 'soccer') {
            const totals = [];
            let maxCorners = 0;
            let minCorners = 1000;

            h2h.deepStats.forEach(game => {
                const homeCorners = game?.homeStats?.corners || 0;
                const awayCorners = game?.awayStats?.corners || 0;
                const total = homeCorners + awayCorners;
                if (total > 0) {
                    totals.push(total);
                    if (total > maxCorners) maxCorners = total;
                    if (total < minCorners) minCorners = total;
                }
            });

            if (totals.length > 0) {
                const sum = totals.reduce((a, b) => a + b, 0);
                const avgCorners = sum / totals.length;

                const baseLine = Math.round(avgCorners);
                const line = baseLine + 0.5;
                const diffFromLine = avgCorners - line;

                const direction = diffFromLine >= 0 ? 'Over' : 'Under';
                const absDiff = Math.abs(diffFromLine);
                const baseConfidence = 60;
                const strengthBoost = Math.min(absDiff * 15, 25);

                cornersPrediction = `${direction} ${line} Corners`;
                cornersConfidence = baseConfidence + strengthBoost;

                factors.push({
                    label: `H2H Avg Corners ${avgCorners.toFixed(1)}`,
                    side: "neutral",
                    type: "info"
                });
            }
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
    
    const diff = homeScore - awayScore;
    const isBasketball = sport === 'basketball';

    let winPrediction = null;
    let winConfidence = 0;

    // A. Win Prediction Logic (Moneyline/Double Chance)
    if (diff > 12) {
        if (isBasketball) {
            winPrediction = `${homeName} Win`;
            winConfidence = Math.min(65 + diff, 95);
        } else {
            // Soccer: Strong favorite
            winPrediction = `${homeName} Win`;
            winConfidence = Math.min(65 + diff, 92);
        }
    } else if (diff < -12) {
        if (isBasketball) {
            winPrediction = `${awayName} Win`;
            winConfidence = Math.min(65 + Math.abs(diff), 95);
        } else {
            // Soccer: Strong favorite
            winPrediction = `${awayName} Win`;
            winConfidence = Math.min(65 + Math.abs(diff), 92);
        }
    } else {
        if (isBasketball) {
            // Basketball rarely has draws, but could be a "coin flip"
            winPrediction = diff > 0 ? `${homeName} Slight Edge` : `${awayName} Slight Edge`;
            winConfidence = 55 + Math.abs(diff);
        } else {
            // Soccer: Close match / Draw potential
            if (diff > 5) {
                winPrediction = `1X (Home Win or Draw)`;
                winConfidence = 65;
            } else if (diff < -5) {
                winPrediction = `X2 (Away Win or Draw)`;
                winConfidence = 65;
            } else {
                winPrediction = "Competitive / Draw Potential";
                winConfidence = 55;
            }
        }
    }

    let winPredictionValue = winPrediction; // Internal tracking

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
            // Improved Formula: (Home Offense + Away Defense)/2 + (Away Offense + Home Defense)/2
            let homeExp = (hAvgScored + aAvgConceded) / 2;
            let awayExp = (aAvgScored + hAvgConceded) / 2;
            let totalPoints = homeExp + awayExp;
            
            // Adjust based on H2H history for Basketball
            if (h2hAvgGoals > 0) {
                totalPoints = (totalPoints * 0.7) + (h2hAvgGoals * 0.3);
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
            // Use percentage margin for league adaptability (3.5% of total)
            const margin = Math.max(5, Math.round(projectedTotalPoints * 0.035)); 
            const overLine = Math.floor(projectedTotalPoints - margin) + 0.5;
            const underLine = Math.ceil(projectedTotalPoints + margin) - 0.5;

            // Determine Over/Under
            // Dynamic Logic: Bias towards Over unless strong indicators for Under exist
            
            let preferUnder = false;
            let reasonForUnder = "";
            let underConfidenceBoost = 0;

            // Signal 1: H2H is significantly lower than projection
            if (h2hAvgGoals > 0 && h2hAvgGoals < projectedTotalPoints - 8) {
                preferUnder = true;
                reasonForUnder = "H2H Low";
                underConfidenceBoost += 5;
            }
            
            // Signal 2: Recent form is significantly trending down
            const recentTrend = (hLastGamePts + aLastGamePts) / 2; // Last game sum
            if (hLastGamePts > 0 && aLastGamePts > 0 && recentTrend < projectedTotalPoints - 10) {
                preferUnder = true;
                reasonForUnder = reasonForUnder ? reasonForUnder + " & Recent Low" : "Recent Games Low";
                underConfidenceBoost += 5;
            }

            // Signal 3: General Low Scoring (Defensive Teams)
            if (projectedTotalPoints < 210) {
                 preferUnder = true;
                 reasonForUnder = reasonForUnder ? reasonForUnder + " & Low Proj" : "Defensive Matchup";
                 underConfidenceBoost += 5;
            }

            if (preferUnder) {
                goalsPrediction = `Under ${underLine}`;
                goalsConfidence = 65 + confidenceBoost + underConfidenceBoost; // Base increased from previous implicit 65
                factors.push({ label: `Trend: Low Scoring (${reasonForUnder})`, side: "neutral", type: "warning" });
            } else {
                goalsPrediction = `Over ${overLine}`;
                goalsConfidence = 68 + confidenceBoost;
                factors.push({ label: `Proj. Total ${predictedLine} Pts`, side: "neutral", type: "success" });
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
                 }
            });
            const total = h2h.homeWins + h2h.awayWins;
            if (total > 0) {
                if (h2h.homeWins / total > 0.6) projectedMargin += 3;
                if (h2h.awayWins / total > 0.6) projectedMargin -= 3;
            }
        }

        // 5. Margin Precision Logic (Winning Margin Range)
        let winningMarginNode = null;
        if (Math.abs(projectedMargin) > 0) {
            const absMargin = Math.abs(projectedMargin);
            let range = "";
            if (absMargin <= 5) range = "1-5 Pts";
            else if (absMargin <= 10) range = "6-10 Pts";
            else if (absMargin <= 15) range = "11-15 Pts";
            else range = "16+ Pts";
            
            winningMarginNode = {
                type: 'MARGIN',
                label: 'Winning Margin',
                value: `${projectedMargin > 0 ? homeName : awayName} by ${range}`,
                confidence: Math.round(Math.min(65 + (5 / Math.max(1, absMargin % 5)), 85)),
                color: projectedMargin > 0 ? COLORS.success : COLORS.error
            };
        }

        // 6. 1st Half Prediction
        // Basketball: If Home start strong (record), they likely win 1st half
        let firstHalfNode = {
            type: 'HALF',
            label: '1st Half Winner',
            value: projectedMargin > 2 ? homeName : (projectedMargin < -2 ? awayName : "Draw / Close"),
            confidence: 68,
            color: projectedMargin > 2 ? COLORS.success : (projectedMargin < -2 ? COLORS.error : COLORS.textSecondary)
        };
    }

    // C. SECURE & VALUE RECOMMENDATIONS (Multi-Outcome)
    const recommendations = [];

    // 1. Double Chance (Soccer Only)
    if (!isBasketball) {
        if (Math.abs(diff) < 15) { // If it's fairly competitive
            if (diff > 4) {
                 recommendations.push({
                    type: 'DC',
                    label: 'Double Chance',
                    value: `1X (${homeName} or Draw)`,
                    confidence: 75,
                    color: '#4dabf7'
                });
            } else if (diff < -4) {
                 recommendations.push({
                    type: 'DC',
                    label: 'Double Chance',
                    value: `X2 (${awayName} or Draw)`,
                    confidence: 75,
                    color: '#ff8787'
                });
            }
        }
    }

    // 2. Win Prediction (Moneyline)
    if (winPrediction) {
        let winColor = COLORS.textSecondary;
        if (winPrediction.includes(homeName)) winColor = COLORS.success;
        else if (winPrediction.includes(awayName)) winColor = COLORS.error;
        
        recommendations.push({
            type: 'WIN',
            label: 'Moneyline',
            value: winPrediction,
            confidence: winConfidence,
            color: winColor
        });
    }

    // 3. Totals (Goals/Points)
    if (goalsPrediction) {
        recommendations.push({
            type: 'TOTAL',
            label: 'Over/Under',
            value: goalsPrediction,
            confidence: goalsConfidence,
            color: COLORS.accent
        });
    }

    // 4. Both Teams to Score (Soccer Only)
    if (!isBasketball && hAvgScored > 0 && aAvgScored > 0) {
        const bttsProb = (hAvgScored > 0.8 && aAvgScored > 0.8) ? (hAvgScored + aAvgScored) / 4 : 0.5;
        const result = bttsProb > 0.6 ? 'BTTS: Yes' : (bttsProb < 0.4 ? 'BTTS: No' : null);
        if (result) {
            recommendations.push({
                type: 'BTTS',
                label: 'Goals',
                value: result,
                confidence: Math.round(Math.min(60 + (Math.abs(bttsProb - 0.5) * 100), 88)),
                color: '#ae3ec9'
            });
        }
    }

    // 5. Total Bookings (Soccer Only)
    // Using H2H card data as a primary indicator
    if (!isBasketball && h2h && h2h.deepStats && h2h.deepStats.length > 0) {
        const cardTotals = h2h.deepStats.map(g => (g.homeStats?.yellowCards || 0) + (g.awayStats?.yellowCards || 0));
        const avgCards = cardTotals.reduce((a, b) => a + b, 0) / cardTotals.length;
        
        if (avgCards > 0) {
            const line = avgCards > 4.5 ? 4.5 : 3.5;
            const direction = avgCards > line ? 'Over' : 'Under';
            recommendations.push({
                type: 'CARDS',
                label: 'Bookings',
                value: `${direction} ${line} Cards`,
                confidence: Math.round(65 + (Math.abs(avgCards - line) * 10)),
                color: '#fcc419'
            });
        }
    }

    // 6. Basketball Spreads
    if (isBasketball && projectedMargin !== 0) {
        const spreadBuffer = 3.5;
        const line = Math.floor(Math.abs(projectedMargin) - spreadBuffer) + 0.5;
        if (line > 2) {
             const favorite = projectedMargin > 0 ? homeName : awayName;
             recommendations.push({
                type: 'SPREAD',
                label: 'Handicap',
                value: `${favorite} -${line}`,
                confidence: 72,
                color: projectedMargin > 0 ? COLORS.success : COLORS.error
            });
        }
    }

    // 7. Team Totals (Basketball)
    if (isBasketball) {
        if (homeTeamTotalPrediction) {
            recommendations.push({
                type: 'TEAM_TOTAL',
                label: 'Home Total',
                value: homeTeamTotalPrediction.replace(homeName, '').trim(),
                confidence: homeTeamTotalConfidence,
                color: COLORS.success
            });
        }
        if (awayTeamTotalPrediction) {
            recommendations.push({
                type: 'TEAM_TOTAL',
                label: 'Away Total',
                value: awayTeamTotalPrediction.replace(awayName, '').trim(),
                confidence: awayTeamTotalConfidence,
                color: COLORS.error
            });
        }
        // New Basketball-specific nodes
        if (typeof winningMarginNode !== 'undefined' && winningMarginNode) recommendations.push(winningMarginNode);
        if (typeof firstHalfNode !== 'undefined' && firstHalfNode) recommendations.push(firstHalfNode);
    }

    // 8. Corners Candidate
    if (cornersPrediction) {
        recommendations.push({
            type: 'CORNERS',
            label: 'Corners',
            value: cornersPrediction,
            confidence: cornersConfidence,
            color: COLORS.info
        });
    }

    // Sort by confidence so the "Best" is first but all are available
    recommendations.sort((a, b) => b.confidence - a.confidence);

    return {
        prediction: recommendations.length > 0 ? recommendations[0].value : "Too Close to Call",
        confidence: recommendations.length > 0 ? recommendations[0].confidence : 45,
        color: recommendations.length > 0 ? recommendations[0].color : COLORS.textSecondary,
        recommendations: recommendations, // All tips returned!
        factors
    };
};
