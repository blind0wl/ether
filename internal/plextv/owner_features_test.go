package plextv

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
)

func TestRegistrarPublishesOwnerFeatures(t *testing.T) {
	f := newFakePlexTV(t, testMachineID)
	account := owner()
	account.Subscription.Features = []string{"pass", "remote-watch-pass"}
	f.addUser("user-token", account)
	r, err := NewRegistrar(RegistrarOptions{Config: &memConfig{cfg: testConfig()}, Client: newServerClient(t, f)})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	check := func(want []string) {
		t.Helper()
		b, err := json.Marshal(r.Status())
		if err != nil {
			t.Fatal(err)
		}
		var st struct {
			OwnerFeatures []string `json:"ownerFeatures"`
		}
		if err := json.Unmarshal(b, &st); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(st.OwnerFeatures, want) {
			t.Fatalf("owner features = %v, want %v", st.OwnerFeatures, want)
		}
	}
	if _, err := r.Claim(ctx, "user-token"); err != nil {
		t.Fatal(err)
	}
	check(account.Subscription.Features)
	// Changes must replace the previous snapshot, including revoked features.
	account.Subscription.Features = []string{"pass"}
	f.addUser("server-token-42", account)
	if err := r.RefreshOwner(ctx); err != nil {
		t.Fatal(err)
	}
	check(account.Subscription.Features)
	if err := r.Unclaim(ctx); err != nil {
		t.Fatal(err)
	}
	check(nil)
}
