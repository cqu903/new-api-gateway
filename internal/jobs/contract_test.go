package jobs

import "testing"

// 锁定性质：这些常量值与 Python 端 workers/analysis_worker/contract.py 同名同值。
// drift 时本测试失败。见 ADR-0003、CONTEXT.md → analysis job contract。

func TestStreamContractConstants(t *testing.T) {
	for _, tt := range []struct {
		name string
		got  string
		want string
	}{
		{"StageCore", StageCore, "core"},
		{"StageEnrichment", StageEnrichment, "enrichment"},
		{"DefaultRedisCoreStream", DefaultRedisCoreStream, "analysis.core"},
		{"DefaultRedisEnrichmentStream", DefaultRedisEnrichmentStream, "analysis.enrichment"},
		{"GroupCore", GroupCore, "analysis-core-workers"},
		{"GroupEnrichment", GroupEnrichment, "analysis-enrichment-workers"},
	} {
		if tt.got != tt.want {
			t.Errorf("%s = %q, want %q", tt.name, tt.got, tt.want)
		}
	}
}
