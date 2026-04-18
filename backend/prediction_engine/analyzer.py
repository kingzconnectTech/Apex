import pandas as pd
import numpy as np
from scipy import stats

class PerformanceAnalyzer:
    def __init__(self, data_frame):
        """
        data_frame: pandas DataFrame with columns like ['date', 'team_id', 'role', 'sprint', 'project', 'metric_value']
        """
        self.df = data_frame
        # Convert date to datetime
        if 'date' in self.df.columns:
            self.df['date'] = pd.to_datetime(self.df['date'])

    def slice_and_analyze(self, dimensions=['role', 'sprint', 'project']):
        """
        Perform multi-dimensional slicing and calculate basic stats.
        """
        # Efficient grouping for large datasets
        grouped = self.df.groupby(dimensions)['metric_value'].agg(['mean', 'std', 'count']).reset_index()
        return grouped

    def test_significance(self, group_a_filter, group_b_filter, metric='metric_value'):
        """
        Perform T-test for statistical significance (p < 0.05).
        """
        group_a = self.df.query(group_a_filter)[metric]
        group_b = self.df.query(group_b_filter)[metric]
        
        t_stat, p_val = stats.ttest_ind(group_a, group_b, equal_var=False)
        
        return {
            "t_stat": float(t_stat),
            "p_value": float(p_val),
            "significant": p_val < 0.05
        }

    def detect_anomalies(self, metric='metric_value'):
        """
        Anomaly detection using 3-sigma rule.
        """
        mean = self.df[metric].mean()
        std = self.df[metric].std()
        
        threshold = 3 * std
        anomalies = self.df[np.abs(self.df[metric] - mean) > threshold]
        
        return anomalies

    def get_summary_stats(self):
        """
        Optimized summary for dashboard.
        """
        # Using vectorized operations for speed
        summary = {
            "total_rows": len(self.df),
            "global_mean": float(self.df['metric_value'].mean()),
            "global_std": float(self.df['metric_value'].std()),
            "anomalies_count": len(self.detect_anomalies())
        }
        return summary

# Example usage for performance benchmark
if __name__ == "__main__":
    import time
    
    # Generate 10k rows of dummy data
    n = 10000
    data = {
        'date': pd.date_range(start='2023-01-01', periods=n, freq='H'),
        'team_id': np.random.randint(1, 10, n),
        'role': np.random.choice(['Dev', 'QA', 'PM'], n),
        'sprint': np.random.randint(1, 20, n),
        'project': np.random.choice(['Alpha', 'Beta', 'Gamma'], n),
        'metric_value': np.random.normal(50, 10, n)
    }
    df = pd.DataFrame(data)
    
    analyzer = PerformanceAnalyzer(df)
    
    start_time = time.time()
    
    # Perform operations
    slices = analyzer.slice_and_analyze()
    sig_test = analyzer.test_significance("role == 'Dev'", "role == 'QA'")
    anomalies = analyzer.detect_anomalies()
    
    end_time = time.time()
    
    print(f"Analysis of {n} rows took {end_time - start_time:.4f} seconds")
    print(f"Significant: {sig_test['significant']} (p={sig_test['p_value']:.4f})")
    print(f"Anomalies found: {len(anomalies)}")
