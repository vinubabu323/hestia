.PHONY: proto

proto:
	protoc \
		--go_out=proto/gen/go --go_opt=paths=source_relative \
		--go-grpc_out=proto/gen/go --go-grpc_opt=paths=source_relative \
		--proto_path=proto \
		proto/hestia.proto
