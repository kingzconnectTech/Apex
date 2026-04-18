import unittest
import pandas as pd
import numpy as np
import os
import sys
from datetime import datetime

# Add parent dir to path to import models
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ensemble_manager import EnsembleManager
from analyzer import PerformanceAnalyzer

class TestPredictionEngine(unittest.TestCase):
    def setUp(self):
        self.model_dir = "test_models"
        if not os.path.exists(self.model_dir):
            os.makedirs(self.model_dir)
        self.ensemble = EnsembleManager(model_dir=self.model_dir)

    def test_analyzer_performance(self):
        n = 10000
        data = {
            'date': pd.date_range(start='2023-01-01', periods=n, freq='H'),
            'role': np.random.choice(['Dev', 'QA'], n),
            'sprint': np.random.randint(1, 10, n),
            'project': np.random.choice(['A', 'B'], n),
            'metric_value': np.random.normal(50, 10, n)
        }
        df = pd.DataFrame(data)
        analyzer = PerformanceAnalyzer(df)
        
        start_time = datetime.now()
        analyzer.slice_and_analyze()
        duration = (datetime.now() - start_time).total_seconds()
        
        self.assertLess(duration, 1.0, "Analysis took too long")

    def test_anomaly_detection(self):
        data = {'metric_value': [10, 10, 10, 10, 10, 1000]} # 1000 is an anomaly
        df = pd.DataFrame(data)
        analyzer = PerformanceAnalyzer(df)
        anomalies = analyzer.detect_anomalies()
        self.assertEqual(len(anomalies), 1)

    def test_ensemble_retraining(self):
        # Create dummy data
        dates = pd.date_range(end=datetime.now(), periods=50)
        data = pd.DataFrame({'ds': dates, 'y': np.random.randn(50).cumsum()})
        
        # Test retraining (simplified for speed in tests)
        # In a real test, we might mock the tune methods
        results = self.ensemble.retrain_all(data)
        self.assertIn('arima', results)
        self.assertIsNotNone(self.ensemble.winning_model_name)

if __name__ == '__main__':
    unittest.main()
