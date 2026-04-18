import time
import json
import os
from main import PredictionEngine
import pandas as pd

def monitor_accuracy():
    """
    Check the accuracy of the current winning model.
    """
    meta_path = "models/winning_model.meta"
    if os.path.exists(meta_path):
        with open(meta_path, 'rb') as f:
            import joblib
            meta = joblib.load(meta_path)
            mae = meta.get('mae', 1.0)
            
            # MAE <= 5% requirement (assuming metric scale is 0-100 for simplicity)
            # In real case, we'd normalize or use MAPE
            status = "OK" if mae <= 5.0 else "WARNING"
            
            return {
                "model": meta['name'],
                "mae": mae,
                "status": status,
                "last_updated": meta['updated_at']
            }
    return {"status": "ERROR", "message": "No model found"}

def run_nightly_job():
    engine = PredictionEngine()
    print(f"[{pd.Timestamp.now()}] Starting nightly retraining job...")
    
    try:
        results = engine.train_nightly()
        print(f"[{pd.Timestamp.now()}] Nightly retraining success. Results: {results}")
        
        # Accuracy check
        accuracy = monitor_accuracy()
        print(f"[{pd.Timestamp.now()}] Current model accuracy: {accuracy}")
        
        # Log to a history file for dashboard monitoring
        history_file = "models/training_history.jsonl"
        with open(history_file, "a") as f:
            log_entry = {
                "timestamp": pd.Timestamp.now().isoformat(),
                "results": results,
                "accuracy": accuracy
            }
            f.write(json.dumps(log_entry) + "\n")
            
    except Exception as e:
        print(f"[{pd.Timestamp.now()}] Nightly job failed: {e}")

if __name__ == "__main__":
    run_nightly_job()
