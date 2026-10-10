package discovery

import (
	"context"
	"errors"
	"sync"
)

const (
	BridgeCommandDiscoveryRequested = "discovery-requested"
	BridgeCommandDiscoveryCancelled = "discovery-cancelled"
	bridgeCommandBuffer             = 4
)

var (
	ErrExecutorAlreadyConnected = errors.New("browser discovery executor already connected")
	ErrExecutorBackpressure     = errors.New("browser discovery executor command buffer is full")
)

type BridgeCommand struct {
	Type        string                `json:"type"`
	DiscoveryID string                `json:"discoveryId"`
	Input       *CreateDiscoveryInput `json:"input,omitempty"`
}

type BrokerConnection struct {
	id       uint64
	commands chan BridgeCommand
	Commands <-chan BridgeCommand
}

type Broker struct {
	mu           sync.Mutex
	nextID       uint64
	connection   *BrokerConnection
	activeID     string
	onConnect    func()
	onDisconnect func(string)
}

func NewBroker() *Broker {
	return &Broker{}
}

func (b *Broker) SetLifecycleHooks(onConnect func(), onDisconnect func(string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onConnect = onConnect
	b.onDisconnect = onDisconnect
}

func (b *Broker) Connect() (*BrokerConnection, error) {
	b.mu.Lock()
	if b.connection != nil {
		b.mu.Unlock()
		return nil, ErrExecutorAlreadyConnected
	}
	b.nextID++
	commands := make(chan BridgeCommand, bridgeCommandBuffer)
	connection := &BrokerConnection{
		id:       b.nextID,
		commands: commands,
		Commands: commands,
	}
	b.connection = connection
	onConnect := b.onConnect
	b.mu.Unlock()

	if onConnect != nil {
		onConnect()
	}
	return connection, nil
}

func (b *Broker) Disconnect(connection *BrokerConnection) {
	if connection == nil {
		return
	}
	b.mu.Lock()
	if b.connection == nil || b.connection.id != connection.id {
		b.mu.Unlock()
		return
	}
	activeID := b.activeID
	b.connection = nil
	b.activeID = ""
	onDisconnect := b.onDisconnect
	b.mu.Unlock()

	if onDisconnect != nil {
		onDisconnect(activeID)
	}
}

func (b *Broker) Available() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connection != nil
}

func (b *Broker) Dispatch(ctx context.Context, job DiscoveryJob) error {
	input := job.Input
	return b.send(ctx, BridgeCommand{
		Type:        BridgeCommandDiscoveryRequested,
		DiscoveryID: job.ID,
		Input:       &input,
	}, job.ID)
}

func (b *Broker) Cancel(ctx context.Context, id string) error {
	return b.send(ctx, BridgeCommand{
		Type:        BridgeCommandDiscoveryCancelled,
		DiscoveryID: id,
	}, "")
}

func (b *Broker) Finish(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.activeID == id {
		b.activeID = ""
	}
}

func (b *Broker) send(ctx context.Context, command BridgeCommand, activeID string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	if b.connection == nil {
		return ErrExecutorUnavailable
	}
	select {
	case b.connection.commands <- command:
		if activeID != "" {
			b.activeID = activeID
		}
		return nil
	default:
		return ErrExecutorBackpressure
	}
}
