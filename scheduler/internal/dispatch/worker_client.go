package dispatch

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "github.com/vinubabu/hestia/proto/gen/go/hestia"
)

type WorkerClient struct {
	client pb.WorkerClient
	conn   *grpc.ClientConn
}

func NewWorkerClient(addr string) (*WorkerClient, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	return &WorkerClient{client: pb.NewWorkerClient(conn), conn: conn}, nil
}

func (w *WorkerClient) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err := w.client.Ping(ctx, &pb.PingRequest{})
	return err
}

func (w *WorkerClient) Execute(ctx context.Context, req *pb.ExecuteRequest, timeout time.Duration) (*pb.ExecuteResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return w.client.Execute(ctx, req)
}

func (w *WorkerClient) Close() error {
	return w.conn.Close()
}
