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

class PredictionEngine:
    def __init__(self, model_dir="models"):
        self.model_dir = model_dir
        if not os.path.exists(model_dir):
            os.makedirs(model_dir)
        
        self.ensemble = EnsembleManager(model_dir=model_dir)
        self.load_models()

    def load_models(self):
        try:
            self.ensemble.load_latest_winning_model()
        except Exception as e:
            print(f"Error loading models: {e}")

    def predict(self, team_id, sport, league):
        """
        Generate a prediction for a team's next performance metric.
        """
        # 1. Fetch historical data for the team
        # (This would use EspnClient to get historical stats)
        # For demonstration, we'll assume we have a time series of a metric
        
        # 2. Get predictions from the ensemble
        result = self.ensemble.predict(team_id, sport, league)
        
        return result

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
