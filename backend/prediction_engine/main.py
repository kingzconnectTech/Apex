import sys
import json
import asyncio
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, List, Optional
from datetime import datetime
import os

# Import models
from model_arima import ARIMAModel
from model_prophet import ProphetModel
from model_lstm import LSTMModel
from ensemble_manager import EnsembleManager

# Import ESPN client
from espn_api import EspnClient

class PredictionEngine:
    def __init__(self, model_dir: str = "models"):
        self.model_dir = model_dir
        if not os.path.exists(model_dir):
            os.makedirs(model_dir)
        
        # Preload models once at initialization
        self.ensemble = EnsembleManager(model_dir=model_dir)
        self.ensemble.load_latest_winning_model()

    async def predict(self, team_or_athlete_id: str, sport: str, league: str, 
                      opponent_id: Optional[str] = None, 
                      espn_client: Optional[EspnClient] = None) -> Dict[str, Any]:
        """Generate a prediction using sophisticated factors."""
        # Use provided client or create a temporary one
        client = espn_client if espn_client else EspnClient()
        
        try:
            if sport == "tennis":
                # Tennis prediction
                player_form = await client.analyze_athlete_form(sport, league, team_or_athlete_id)
                opponent_form = None
                h2h = None
                if opponent_id:
                    opponent_form = await client.analyze_athlete_form(sport, league, opponent_id)
                    h2h = await client.get_head_to_head(sport, league, team_or_athlete_id, opponent_id)
                prediction = self._predict_tennis(player_form, team_or_athlete_id, league, opponent_form, h2h)
                return prediction
            else:
                # Other sports prediction
                team_form = await client.analyze_team_form(sport, league, team_or_athlete_id)
                result = self.ensemble.predict(team_or_athlete_id, sport, league)
                if team_form:
                    result["form"] = team_form
                return result
        finally:
            if not espn_client:
                await client.client.aclose()

    def _predict_tennis(self, player_form: Dict[str, Any], player_id: str, league: str,
                        opponent_form: Optional[Dict[str, Any]] = None,
                        head_to_head: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Sophisticated tennis prediction logic (unchanged)."""
        if not player_form or player_form["match_count"] == 0:
            return {
                "prediction": "unknown",
                "confidence": 0.0,
                "player_id": player_id,
                "league": league,
                "form": player_form,
                "opponent_form": opponent_form,
                "head_to_head": head_to_head
            }
        
        # Calculate base win rate
        player_win_rate = player_form["wins"] / player_form["match_count"]
        confidence = 0.5 + (player_win_rate * 0.3)
        
        # Factor 1: Streaks
        if player_form.get("win_streak", 0) >= 3:
            confidence += 0.1
        elif player_form.get("loss_streak", 0) >= 3:
            confidence -= 0.1
            
        # Factor 2: Head-to-head
        if head_to_head:
            total_h2h = head_to_head['wins_athlete1'] + head_to_head['wins_athlete2']
            if total_h2h > 0:
                h2h_win_rate = head_to_head['wins_athlete1'] / total_h2h
                confidence += (h2h_win_rate - 0.5) * 0.2
                
        # Factor 3: Opponent form (if available)
        if opponent_form and opponent_form["match_count"] > 0:
            opponent_win_rate = opponent_form["wins"] / opponent_form["match_count"]
            confidence -= (opponent_win_rate - 0.5) * 0.15
            
        # Factor 4: Injury status
        if player_form.get("injury_status") != "healthy":
            confidence -= 0.15
            
        # Clamp confidence
        confidence = max(0.05, min(0.95, confidence))
        
        prediction = "win" if confidence > 0.5 else "loss"
        
        return {
            "prediction": prediction,
            "confidence": round(confidence, 2),
            "player_id": player_id,
            "league": league,
            "form": player_form,
            "opponent_form": opponent_form,
            "head_to_head": head_to_head
        }
        
    async def get_match_predictions(self, sport: str, league: str) -> List[Dict[str, Any]]:
        """
        Optimized prediction generation:
        1. Fetch all fixtures
        2. Collect unique teams
        3. Fetch team data in parallel
        4. Generate predictions
        """
        start_time = time.perf_counter()
        
        # Step 1: Fetch fixtures
        t_fixtures_start = time.perf_counter()
        async with EspnClient() as client:
            scoreboard = await client.get_matches(sport, league)
            t_fixtures = time.perf_counter() - t_fixtures_start
            
            if not scoreboard or 'events' not in scoreboard:
                print(f"Fixtures: {t_fixtures:.3f}s, Total: {time.perf_counter() - start_time:.3f}s")
                return []
            
            predictions = []
            matches = []
            unique_teams = set()
            
            # Step 2: Collect matches and unique teams
            for event in scoreboard['events']:
                competitors = event.get('competitions', [{}])[0].get('competitors', [])
                if len(competitors) < 2:
                    continue
                
                id1 = competitors[0].get('id')
                id2 = competitors[1].get('id')
                if not id1 or not id2:
                    continue
                
                matches.append({
                    "event": event,
                    "id1": id1,
                    "id2": id2
                })
                
                unique_teams.add(id1)
                unique_teams.add(id2)
            
            # Step 3: Fetch all unique team/athlete data in parallel (caching will prevent duplicates)
            t_stats_start = time.perf_counter()
            fetch_tasks = []
            for team_id in unique_teams:
                if sport == "tennis":
                    fetch_tasks.append(client.analyze_athlete_form(sport, league, team_id))
                else:
                    fetch_tasks.append(client.analyze_team_form(sport, league, team_id))
            await asyncio.gather(*fetch_tasks, return_exceptions=True)
            t_stats = time.perf_counter() - t_stats_start
            
            # Step 4: Generate predictions
            t_pred_start = time.perf_counter()
            for match in matches:
                try:
                    pred = await self.predict(
                        match["id1"], sport, league, match["id2"],
                        espn_client=client
                    )
                    predictions.append({
                        "match_id": match["event"].get('id'),
                        "match_name": match["event"].get('name'),
                        "prediction": pred,
                        "is_live": match["event"].get('competitions', [{}])[0].get('status', {}).get('type', {}).get('state') == 'in'
                    })
                except Exception as e:
                    print(f"Prediction failed for match {match['event'].get('id')}: {e}")
                    continue
            t_pred = time.perf_counter() - t_pred_start
            total_time = time.perf_counter() - start_time
            
            # Print performance metrics
            print(f"Fixtures: {t_fixtures:.3f}s")
            print(f"Statistics: {t_stats:.3f}s")
            print(f"Prediction: {t_pred:.3f}s")
            print(f"Total: {total_time:.3f}s")
            
            return predictions

    def train_nightly(self):
        """Nightly training (unchanged)."""
        print("Starting nightly retraining...")
        metrics = self.ensemble.retrain_all()
        print(f"Retraining complete. Metrics: {metrics}")
        return metrics

if __name__ == "__main__":
    engine = PredictionEngine()
    
    if len(sys.argv) > 1 and sys.argv[1] == "--train":
        result = engine.train_nightly()
        print(json.dumps(result))
    elif len(sys.argv) > 3 and sys.argv[1] == "--predictions":
        try:
            sport = sys.argv[2]
            league = sys.argv[3]
            predictions = asyncio.run(engine.get_match_predictions(sport, league))
            print(json.dumps({"predictions": predictions}))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
    else:
        try:
            input_data = json.load(sys.stdin)
            team_id = input_data.get("teamId")
            sport = input_data.get("sport", "soccer")
            league = input_data.get("league", "eng.1")
            opponent_id = input_data.get("opponentId")
            
            prediction = asyncio.run(engine.predict(team_id, sport, league, opponent_id))
            print(json.dumps(prediction))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
