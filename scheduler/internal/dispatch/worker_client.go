package dispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type WorkerClient struct {
	baseURL string
	client  *http.Client
}

type ExecuteRequest struct {
	JobID          string
	TenantID       string
	IdempotencyKey string
	PayloadJSON    string
	Attempt        int32
}

type ExecuteResponse struct {
	Success      bool
	ErrorMessage string
}

func NewWorkerClient(baseURL string) (*WorkerClient, error) {
	return &WorkerClient{
		baseURL: baseURL,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}, nil
}

func (w *WorkerClient) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, w.baseURL+"/health", nil)
	if err != nil {
		return err
	}

	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("worker health returned %d", resp.StatusCode)
	}

	return nil
}

func (w *WorkerClient) Execute(ctx context.Context, req *ExecuteRequest, timeout time.Duration) (*ExecuteResponse, error) {
	job := map[string]any{
		"id":             req.JobID,
		"tenantId":       req.TenantID,
		"idempotencyKey": req.IdempotencyKey,
		"attempt":        req.Attempt,
	}

	if req.PayloadJSON != "" {
		var payload any
		if err := json.Unmarshal([]byte(req.PayloadJSON), &payload); err != nil {
			return nil, fmt.Errorf("decode payload_json: %w", err)
		}
		job["payload"] = payload
	}

	bodyBytes, err := json.Marshal(map[string]any{"job": job})
	if err != nil {
		return nil, err
	}

	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(callCtx, http.MethodPost, w.baseURL+"/execute", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := w.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var workerResp struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&workerResp); err != nil {
		return nil, fmt.Errorf("decode worker response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		message := fmt.Sprintf("worker returned %d", resp.StatusCode)
		if workerResp.Error != nil && workerResp.Error.Message != "" {
			message = workerResp.Error.Message
		}
		return &ExecuteResponse{Success: false, ErrorMessage: message}, nil
	}

	return &ExecuteResponse{Success: true}, nil
}

func (w *WorkerClient) Close() error {
	return nil
}
