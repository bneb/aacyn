package plugin

import (
	"encoding/json"
	"testing"
	"time"
)

// ─── Test: DataFrame Construction ───────────────────────────────────────────

func TestBuildDataFrame_Empty(t *testing.T) {
	resp := aacynQueryResponse{
		Columns:    []string{},
		Rows:       [][]interface{}{},
		DurationNs: 0,
		TotalRows:  0,
	}

	frame, err := buildDataFrame(resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if frame.Name != "aacyn_telemetry" {
		t.Errorf("expected frame name 'aacyn_telemetry', got '%s'", frame.Name)
	}
	if len(frame.Fields) != 0 {
		t.Errorf("expected 0 fields, got %d", len(frame.Fields))
	}
}

func TestBuildDataFrame_WithTimestamp(t *testing.T) {
	nowMs := float64(time.Now().UnixMilli())

	resp := aacynQueryResponse{
		Columns: []string{"timestamp", "service", "value"},
		Rows: [][]interface{}{
			{nowMs, "api-gateway", 42.5},
			{nowMs - 1000, "api-gateway", 38.2},
		},
		DurationNs: 150000,
		TotalRows:  2,
	}

	frame, err := buildDataFrame(resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(frame.Fields) != 3 {
		t.Fatalf("expected 3 fields, got %d", len(frame.Fields))
	}

	// Field 0: timestamp → time.Time
	if frame.Fields[0].Name != "timestamp" {
		t.Errorf("expected field name 'timestamp', got '%s'", frame.Fields[0].Name)
	}
	if frame.Fields[0].Len() != 2 {
		t.Errorf("expected 2 rows, got %d", frame.Fields[0].Len())
	}

	// Field 1: service → string
	if frame.Fields[1].Name != "service" {
		t.Errorf("expected field name 'service', got '%s'", frame.Fields[1].Name)
	}

	// Field 2: value → float64
	if frame.Fields[2].Name != "value" {
		t.Errorf("expected field name 'value', got '%s'", frame.Fields[2].Name)
	}
}

func TestBuildDataFrame_NanosTimestamp(t *testing.T) {
	// If timestamp > 1e15, treat as nanoseconds
	tsNano := float64(time.Now().UnixNano())

	resp := aacynQueryResponse{
		Columns: []string{"timestamp", "duration"},
		Rows: [][]interface{}{
			{tsNano, 3.14},
		},
		DurationNs: 286000,
		TotalRows:  1,
	}

	frame, err := buildDataFrame(resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if frame.Fields[0].Len() != 1 {
		t.Fatalf("expected 1 row, got %d", frame.Fields[0].Len())
	}
}

func TestBuildDataFrame_Metadata(t *testing.T) {
	resp := aacynQueryResponse{
		Columns:    []string{"value"},
		Rows:       [][]interface{}{{1.0}},
		DurationNs: 286000,
		TotalRows:  5000000,
	}

	frame, err := buildDataFrame(resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if frame.Meta == nil {
		t.Fatal("expected frame metadata to be set")
	}

	meta, ok := frame.Meta.Custom.(map[string]interface{})
	if !ok {
		t.Fatal("expected custom metadata to be a map")
	}

	if meta["durationNs"] != int64(286000) {
		t.Errorf("expected durationNs=286000, got %v", meta["durationNs"])
	}
	if meta["totalRows"] != int64(5000000) {
		t.Errorf("expected totalRows=5000000, got %v", meta["totalRows"])
	}
}

// ─── Test: Query Model Parsing ──────────────────────────────────────────────

func TestQueryModelParsing(t *testing.T) {
	raw := `{"queryText":"SELECT * FROM events WHERE is_error = 1"}`

	var qm queryModel
	if err := json.Unmarshal([]byte(raw), &qm); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if qm.QueryText != "SELECT * FROM events WHERE is_error = 1" {
		t.Errorf("expected query text, got '%s'", qm.QueryText)
	}
}

// ─── Test: Type Inference Helpers ───────────────────────────────────────────

func TestToFloat64(t *testing.T) {
	cases := []struct {
		input    interface{}
		expected float64
		ok       bool
	}{
		{float64(42), 42.0, true},
		{float32(3.14), 3.140000104904175, true},
		{int(7), 7.0, true},
		{int64(99), 99.0, true},
		{"not a number", 0, false},
	}

	for _, tc := range cases {
		got, ok := toFloat64(tc.input)
		if ok != tc.ok {
			t.Errorf("toFloat64(%v): ok=%v, want %v", tc.input, ok, tc.ok)
		}
		if ok && got != tc.expected {
			t.Errorf("toFloat64(%v): got %f, want %f", tc.input, got, tc.expected)
		}
	}
}

func TestIsNumericColumn(t *testing.T) {
	numericRows := [][]interface{}{{1.0, "hello"}, {2.0, "world"}}
	if !isNumericColumn(numericRows, 0) {
		t.Error("expected column 0 to be numeric")
	}
	if isNumericColumn(numericRows, 1) {
		t.Error("expected column 1 to be non-numeric")
	}
}
