package discovery

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestBrokerAllowsOneExecutorAndDeliversCommands(t *testing.T) {
	broker := NewBroker()
	connection, err := broker.Connect()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.Connect(); !errors.Is(err, ErrExecutorAlreadyConnected) {
		t.Fatalf("second Connect() error = %v", err)
	}
	if !broker.Available() {
		t.Fatal("broker should report an available executor")
	}

	job := DiscoveryJob{
		ID: "job-1",
		Input: CreateDiscoveryInput{
			URL:       "https://example.com/watch",
			Mode:      ModeAuto,
			TimeoutMS: DefaultTimeoutMS,
		},
	}
	if err := broker.Dispatch(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	request := receiveBrokerCommand(t, connection.Commands)
	if request.Type != BridgeCommandDiscoveryRequested || request.DiscoveryID != job.ID || request.Input == nil {
		t.Fatalf("request command = %+v", request)
	}

	if err := broker.Cancel(context.Background(), job.ID); err != nil {
		t.Fatal(err)
	}
	cancel := receiveBrokerCommand(t, connection.Commands)
	if cancel.Type != BridgeCommandDiscoveryCancelled || cancel.DiscoveryID != job.ID || cancel.Input != nil {
		t.Fatalf("cancel command = %+v", cancel)
	}

	broker.Finish(job.ID)
	broker.Disconnect(connection)
	if broker.Available() {
		t.Fatal("broker remained available after disconnect")
	}
}

func TestBrokerDisconnectRequeuesPendingAndFailsRunningJobs(t *testing.T) {
	broker := NewBroker()
	store := NewStore(StoreOptions{Capacity: 20})
	svc := NewService(store, nil, broker)
	broker.SetLifecycleHooks(
		func() { _ = svc.DispatchPending(context.Background()) },
		func(id string) { svc.HandleExecutorDisconnect(id) },
	)

	firstConnection, err := broker.Connect()
	if err != nil {
		t.Fatal(err)
	}
	pending, err := svc.Create(context.Background(), CreateDiscoveryInput{URL: "https://example.com/pending"})
	if err != nil {
		t.Fatal(err)
	}
	_ = receiveBrokerCommand(t, firstConnection.Commands)
	broker.Disconnect(firstConnection)

	got, err := svc.Get(pending.ID)
	if err != nil || got.Status != StatusPending {
		t.Fatalf("pending job after disconnect = %+v, %v", got, err)
	}
	secondConnection, err := broker.Connect()
	if err != nil {
		t.Fatal(err)
	}
	redispatched := receiveBrokerCommand(t, secondConnection.Commands)
	if redispatched.DiscoveryID != pending.ID {
		t.Fatalf("redispatched job = %+v", redispatched)
	}
	if _, err := svc.MarkRunning(pending.ID); err != nil {
		t.Fatal(err)
	}
	broker.Disconnect(secondConnection)

	failed, err := svc.Get(pending.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.Status != StatusFailed || failed.ErrorCode != "discovery_executor_disconnected" {
		t.Fatalf("running job after disconnect = %+v", failed)
	}
}

func TestBrokerRejectsDispatchWithoutConnection(t *testing.T) {
	broker := NewBroker()
	if err := broker.Dispatch(context.Background(), DiscoveryJob{ID: "job-1"}); !errors.Is(err, ErrExecutorUnavailable) {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if err := broker.Cancel(context.Background(), "job-1"); !errors.Is(err, ErrExecutorUnavailable) {
		t.Fatalf("Cancel() error = %v", err)
	}
}

func receiveBrokerCommand(t *testing.T, commands <-chan BridgeCommand) BridgeCommand {
	t.Helper()
	select {
	case command := <-commands:
		return command
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for bridge command")
		return BridgeCommand{}
	}
}
