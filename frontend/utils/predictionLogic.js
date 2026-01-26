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
                         totalGoals += (parts[0] + parts[1]);
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

    if (homeStats.lastMatches && awayStats.lastMatches) {
        const calcAvg = (matches, key) => matches.reduce((sum, m) => sum + (m[key] || 0), 0) / matches.length;
        hAvgScored = calcAvg(homeStats.lastMatches, 'pf');
        aAvgScored = calcAvg(awayStats.lastMatches, 'pf');
        hAvgConceded = calcAvg(homeStats.lastMatches, 'pa');
        aAvgConceded = calcAvg(awayStats.lastMatches, 'pa');
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

    // B. Goals / Totals Logic (Only if detailed stats available)
    let goalsPrediction = null;
    let goalsConfidence = 0;

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
            let totalPoints = hAvgScored + aAvgScored;
            
            // Adjust based on H2H history for Basketball
            if (h2hAvgGoals > 0) {
                totalPoints = (totalPoints * 0.7) + (h2hAvgGoals * 0.3);
            }

            if (totalPoints > 228) {
                goalsPrediction = "Over 225.5 Points";
                goalsConfidence = 75; 
            } else if (totalPoints < 210) {
                goalsPrediction = "Under 225.5 Points";
                goalsConfidence = 70;
            }
        }
    }

    // C. Select Best Prediction
    // Strategy: If Win Confidence is low (< 65%), aggressively look for safer Goal markets
    // Otherwise, standard comparison
    const winThreshold = 65; 
    
    // Check if the win prediction is a Draw/Close Match, which we want to preserve unless Goal signal is strong
    const isDraw = winPrediction.includes("Draw") || winPrediction.includes("Close Match");
    // If it's a draw, require +15 confidence boost to switch. Otherwise +10.
    const switchMargin = isDraw ? 15 : 10;

    // Only switch to Goal Prediction if it's significantly better or if Win Prediction is weak
    // We raised the bar for switching to keep consistency with Tips unless compelling reason
    if ((goalsPrediction && goalsConfidence > winConfidence + switchMargin) || (!isDraw && winConfidence < winThreshold && goalsPrediction && goalsConfidence > winConfidence)) {
        prediction = goalsPrediction;
        finalConfidence = goalsConfidence;
        color = COLORS.accent;
    } else {
        prediction = winPrediction;
        finalConfidence = winConfidence;
        
        if (prediction.includes(homeName)) color = COLORS.success;
        else if (prediction.includes(awayName)) color = COLORS.error;
        else if (prediction.includes('1X')) color = '#4dabf7'; 
        else if (prediction.includes('X2')) color = '#ff8787'; 
        else color = COLORS.textSecondary;
    }

    return {
        prediction,
        confidence: Math.round(finalConfidence),
        color,
        factors
    };
};
