package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

// ─── Instance Settings ──────────────────────────────────────────────────────

// DatasourceSettings holds the per-instance configuration for the plugin.
type DatasourceSettings struct {
	URL string `json:"url"`
}

// Datasource is a single instance of the aacyn data source.
type Datasource struct {
	settings DatasourceSettings
	client   *http.Client
}

// ─── Constructor ────────────────────────────────────────────────────────────

// NewDatasource creates a new instance of the aacyn datasource plugin.
func NewDatasource(_ context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	var s DatasourceSettings
	if err := json.Unmarshal(settings.JSONData, &s); err != nil {
		return nil, fmt.Errorf("failed to parse datasource settings: %w", err)
	}

	if s.URL == "" {
		s.URL = "http://localhost:3001"
	}

	return &Datasource{
		settings: s,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}, nil
}

// Dispose cleans up resources on instance disposal.
func (d *Datasource) Dispose() {}

// ─── Health Check ───────────────────────────────────────────────────────────

// CheckHealth verifies that the aacyn engine is reachable.
func (d *Datasource) CheckHealth(ctx context.Context, req *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	healthURL := d.settings.URL + "/health"

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	if err != nil {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: fmt.Sprintf("Failed to create health request: %v", err),
		}, nil
	}

	resp, err := d.client.Do(httpReq)
	if err != nil {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: fmt.Sprintf("Cannot reach aacyn at %s: %v", healthURL, err),
		}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: fmt.Sprintf("aacyn returned HTTP %d", resp.StatusCode),
		}, nil
	}

	// Parse the health response
	var healthResp struct {
		Status  string `json:"status"`
		Version string `json:"version"`
		Uptime  int64  `json:"uptime"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&healthResp); err != nil {
		return &backend.CheckHealthResult{
			Status:  backend.HealthStatusError,
			Message: fmt.Sprintf("Failed to parse health response: %v", err),
		}, nil
	}

	return &backend.CheckHealthResult{
		Status:  backend.HealthStatusOk,
		Message: fmt.Sprintf("aacyn %s — status: %s, uptime: %ds", healthResp.Version, healthResp.Status, healthResp.Uptime/1000),
	}, nil
}

// ─── Query ──────────────────────────────────────────────────────────────────

// queryModel is the JSON structure sent by the frontend QueryEditor.
type queryModel struct {
	QueryText string `json:"queryText"`
}

// aacynQueryResponse is the JSON response from /v1/query.
type aacynQueryResponse struct {
	Columns    []string        `json:"columns"`
	Rows       [][]interface{} `json:"rows"`
	DurationNs int64           `json:"durationNs"`
	TotalRows  int64           `json:"totalRows"`
}

// QueryData handles incoming queries from the Grafana frontend.
// Each query is translated into an HTTP POST to the aacyn /v1/query endpoint,
// and the response is converted into Grafana data.Frame objects.
func (d *Datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	response := backend.NewQueryDataResponse()

	for _, q := range req.Queries {
		res := d.query(ctx, q)
		response.Responses[q.RefID] = res
	}

	return response, nil
}

func (d *Datasource) query(ctx context.Context, query backend.DataQuery) backend.DataResponse {
	var qm queryModel
	if err := json.Unmarshal(query.JSON, &qm); err != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, fmt.Sprintf("failed to parse query: %v", err))
	}

	if qm.QueryText == "" {
		return backend.ErrDataResponse(backend.StatusBadRequest, "query text is empty")
	}

	// Build the request to aacyn /v1/query
	queryPayload := map[string]interface{}{
		"sql":   qm.QueryText,
		"limit": query.MaxDataPoints,
	}

	// Add time range if available
	if !query.TimeRange.From.IsZero() && !query.TimeRange.To.IsZero() {
		queryPayload["timeRange"] = map[string]int64{
			"startNs": query.TimeRange.From.UnixNano(),
			"endNs":   query.TimeRange.To.UnixNano(),
		}
	}

	payloadBytes, err := json.Marshal(queryPayload)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("failed to marshal query: %v", err))
	}

	queryURL := d.settings.URL + "/v1/query"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, queryURL, io.NopCloser(
		newBytesReader(payloadBytes),
	))
	if err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("failed to create request: %v", err))
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := d.client.Do(httpReq)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("query failed: %v", err))
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("aacyn returned HTTP %d: %s", resp.StatusCode, string(body)))
	}

	// Parse aacyn response
	var aacynResp aacynQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&aacynResp); err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("failed to parse response: %v", err))
	}

	// Convert to Grafana DataFrame
	frame, err := buildDataFrame(aacynResp)
	if err != nil {
		return backend.ErrDataResponse(backend.StatusInternal, fmt.Sprintf("failed to build DataFrame: %v", err))
	}

	log.DefaultLogger.Info("Query executed",
		"query", qm.QueryText,
		"rows", aacynResp.TotalRows,
		"durationNs", aacynResp.DurationNs,
	)

	return backend.DataResponse{
		Frames: []*data.Frame{frame},
	}
}

// ─── DataFrame Construction ─────────────────────────────────────────────────

// buildDataFrame converts the aacyn query response into a Grafana data.Frame.
// Column types are inferred from the data:
//   - Columns named "timestamp" → time.Time
//   - Numeric columns → float64
//   - Everything else → string
func buildDataFrame(resp aacynQueryResponse) (*data.Frame, error) {
	if len(resp.Columns) == 0 {
		return data.NewFrame("aacyn_telemetry"), nil
	}

	// Determine column types from the first row of data
	fields := make([]*data.Field, len(resp.Columns))
	for i, col := range resp.Columns {
		switch {
		case col == "timestamp" || col == "time" || col == "ts":
			times := make([]time.Time, 0, len(resp.Rows))
			for _, row := range resp.Rows {
				if i < len(row) {
					if v, ok := toFloat64(row[i]); ok {
						// Assume milliseconds if value looks like millis, else nanos
						if v > 1e15 {
							times = append(times, time.Unix(0, int64(v)))
						} else {
							times = append(times, time.UnixMilli(int64(v)))
						}
					} else {
						times = append(times, time.Time{})
					}
				}
			}
			fields[i] = data.NewField(col, nil, times)

		case isNumericColumn(resp.Rows, i):
			values := make([]float64, 0, len(resp.Rows))
			for _, row := range resp.Rows {
				if i < len(row) {
					if v, ok := toFloat64(row[i]); ok {
						values = append(values, v)
					} else {
						values = append(values, 0)
					}
				}
			}
			fields[i] = data.NewField(col, nil, values)

		default:
			values := make([]string, 0, len(resp.Rows))
			for _, row := range resp.Rows {
				if i < len(row) {
					values = append(values, fmt.Sprintf("%v", row[i]))
				}
			}
			fields[i] = data.NewField(col, nil, values)
		}
	}

	frame := data.NewFrame("aacyn_telemetry", fields...)
	frame.Meta = &data.FrameMeta{
		Custom: map[string]interface{}{
			"durationNs": resp.DurationNs,
			"totalRows":  resp.TotalRows,
		},
	}

	return frame, nil
}

// ─── Helpers ────────────────────────────────────────────────────────────────

func toFloat64(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func isNumericColumn(rows [][]interface{}, colIdx int) bool {
	for _, row := range rows {
		if colIdx < len(row) {
			if _, ok := toFloat64(row[colIdx]); ok {
				return true
			}
			return false
		}
	}
	return false
}

type bytesReader struct {
	data []byte
	pos  int
}

func newBytesReader(data []byte) *bytesReader {
	return &bytesReader{data: data}
}

func (r *bytesReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}
