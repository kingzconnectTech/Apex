import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
import joblib
import os

# Import models (will create these files next)
from model_arima import ARIMAModel
from model_prophet import ProphetModel
from model_lstm import LSTMModel
from ensemble_manager import EnsembleManager

# Import ESPN client
from espn_api import EspnClient

class PredictionEngine:
    def __init__(self, model_dir="models"):
        self.model_dir = model_dir
        if not os.path.exists(model_dir):
            os.makedirs(model_dir)
        
        self.ensemble = EnsembleManager(model_dir=model_dir)
        self.load_models()
        self.espn_client = EspnClient()

    def load_models(self):
        try:
            self.ensemble.load_latest_winning_model()
        except Exception as e:
            print(f"Error loading models: {e}")

    def predict(self, team_or_athlete_id, sport, league):
        """
        Generate a prediction for a team's or player's next performance.
        """
        # 1. Fetch historical data
        if sport == "tennis":
            # For tennis, get player form and stats
            player_form = self.espn_client.analyze_athlete_form(sport, league, team_or_athlete_id)
            # For tennis, let's create a simple prediction based on recent form
            prediction = self._predict_tennis(player_form, team_or_athlete_id, league)
            return prediction
        else:
            # For other sports, use existing logic
            team_form = self.espn_client.analyze_team_form(sport, league, team_or_athlete_id)
            result = self.ensemble.predict(team_or_athlete_id, sport, league)
            # Add form data to result
            if team_form:
                result["form"] = team_form
            return result

    def _predict_tennis(self, player_form, player_id, league):
        """
        Simple prediction logic for tennis matches using form data.
        """
        if not player_form or player_form["match_count"] == 0:
            return {
                "prediction": "unknown",
                "confidence": 0.0,
                "player_id": player_id,
                "league": league,
                "form": player_form
            }
        
        # Calculate win rate
        win_rate = player_form["wins"] / player_form["match_count"]
        confidence = min(0.95, 0.5 + (win_rate * 0.4))
        
        prediction = "win" if win_rate > 0.5 else "loss"
        
        # Adjust based on streaks
        if player_form.get("win_streak", 0) >= 3:
            confidence = min(0.98, confidence + 0.1)
            prediction = "win"
        elif player_form.get("loss_streak", 0) >= 3:
            confidence = min(0.98, confidence + 0.05)
            prediction = "loss"
        
        return {
            "prediction": prediction,
            "confidence": round(confidence, 2),
            "player_id": player_id,
            "league": league,
            "form": player_form
        }

    def train_nightly(self):
        """
        Triggered nightly to retrain all models and pick the winner.
        """
        print("Starting nightly retraining...")
        # 1. Gather all historical data
        # 2. Train and tune each model using Bayesian Optimization
        # 3. Evaluate models on a validation set
        # 4. Save the winning model (lowest MAE)
        
        metrics = self.ensemble.retrain_all()
        print(f"Retraining complete. Metrics: {metrics}")
        return metrics

if __name__ == "__main__":
    engine = PredictionEngine()
    
    if len(sys.argv) > 1 and sys.argv[1] == "--train":
        result = engine.train_nightly()
        print(json.dumps(result))
    else:
        # Example prediction call
        # In production, this would be called by Node.js with real team_id
        try:
            input_data = json.load(sys.stdin)
            team_id = input_data.get("teamId")
            sport = input_data.get("sport", "soccer")
            league = input_data.get("league", "eng.1")
            
            prediction = engine.predict(team_id, sport, league)
            print(json.dumps(prediction))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
