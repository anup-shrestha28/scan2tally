"""User-management service-role endpoints must remain administrator-only."""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main


class UnexpectedLookupClient:
    async def get(self, *args, **kwargs):
        raise AssertionError("an unauthorized caller must be rejected before a user lookup")


class LookupResponse:
    status_code = 200

    def __init__(self, row):
        self.row = row

    def json(self):
        return [self.row]


class LookupClient:
    def __init__(self, row):
        self.row = row

    async def get(self, *args, **kwargs):
        return LookupResponse(self.row)


def test_operator_cannot_load_a_management_target():
    caller = {
        "id": "operator-id",
        "role": "Operator",
        "organization_id": "shared-org",
    }

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main._load_target_user(
            UnexpectedLookupClient(),
            "same-org-colleague-id",
            caller,
        ))

    assert error.value.status_code == 403
    assert error.value.detail == "Only administrators can manage team members."


def test_admin_can_still_load_a_different_same_org_management_target():
    target = {
        "id": "colleague-id",
        "role": "Operator",
        "organization_id": "shared-org",
        "status": "Active",
    }

    result = asyncio.run(main._load_target_user(
        LookupClient(target),
        target["id"],
        {"id": "admin-id", "role": "Admin", "organization_id": "shared-org"},
    ))

    assert result == target


def test_operator_directory_is_same_org_active_and_output_is_whitelisted(monkeypatch):
    monkeypatch.setattr(main, "supabase_admin_available", True)
    monkeypatch.setattr(main, "SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    captured = {}

    async def resolve(_authorization):
        return {
            "id": "operator-id",
            "role": "Operator",
            "organization_id": "operator-org",
            "status": "Active",
        }

    class DirectoryResponse:
        status_code = 200

        def json(self):
            # Extra keys model a future data-layer mistake. They must never
            # cross the endpoint's explicit output projection.
            return [{
                "id": "member-id",
                "name": "Asha Rai",
                "designation": "Accountant",
                "role": "Admin",
                "email": "private@example.com",
                "phone": "9800000000",
                "status": "Active",
            }]

    class DirectoryClient:
        def __init__(self, *args, **kwargs):
            captured["timeout"] = kwargs.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def get(self, url, headers, params):
            captured.update({"url": url, "headers": headers, "params": params})
            return DirectoryResponse()

    monkeypatch.setattr(main, "resolve_caller", resolve)
    monkeypatch.setattr(main.httpx, "AsyncClient", DirectoryClient)

    result = asyncio.run(main.get_operator_team_directory("Bearer valid-session"))

    assert result == {"members": [{
        "id": "member-id",
        "name": "Asha Rai",
        "designation": "Accountant",
        "role": "Admin",
    }]}
    assert captured["url"] == "https://project.supabase.co/rest/v1/users"
    assert captured["params"] == {
        "select": "id,name,designation,role",
        "organization_id": "eq.operator-org",
        "status": "eq.Active",
        "order": "name.asc,id.asc",
    }
    assert captured["headers"]["apikey"] == "service-role-test-key"


def test_admin_cannot_use_operator_directory(monkeypatch):
    monkeypatch.setattr(main, "supabase_admin_available", True)

    async def resolve(_authorization):
        return {"id": "admin-id", "role": "Admin", "organization_id": "org-id"}

    monkeypatch.setattr(main, "resolve_caller", resolve)

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.get_operator_team_directory("Bearer valid-session"))

    assert error.value.status_code == 403
    assert error.value.detail == "This directory is available to Operators only."


def test_operator_directory_requires_server_configuration(monkeypatch):
    monkeypatch.setattr(main, "supabase_admin_available", False)

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.get_operator_team_directory("Bearer valid-session"))

    assert error.value.status_code == 503
    assert error.value.detail == "The team directory is temporarily unavailable."


def test_operator_directory_requires_server_resolved_organization(monkeypatch):
    monkeypatch.setattr(main, "supabase_admin_available", True)

    async def resolve(_authorization):
        return {"id": "operator-id", "role": "Operator", "organization_id": None}

    monkeypatch.setattr(main, "resolve_caller", resolve)

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.get_operator_team_directory("Bearer valid-session"))

    assert error.value.status_code == 403
    assert error.value.detail == "Your account is not linked to an organization."


@pytest.mark.parametrize("status_code,payload", [
    (500, []),
    (200, {"unexpected": "shape"}),
])
def test_operator_directory_sanitizes_upstream_failures(
    monkeypatch,
    status_code,
    payload,
):
    monkeypatch.setattr(main, "supabase_admin_available", True)

    async def resolve(_authorization):
        return {"id": "operator-id", "role": "Operator", "organization_id": "operator-org"}

    class DirectoryResponse:
        def __init__(self):
            self.status_code = status_code

        def json(self):
            return payload

    class DirectoryClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def get(self, *args, **kwargs):
            return DirectoryResponse()

    monkeypatch.setattr(main, "resolve_caller", resolve)
    monkeypatch.setattr(main.httpx, "AsyncClient", DirectoryClient)

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.get_operator_team_directory("Bearer valid-session"))

    assert error.value.status_code == 503
    assert error.value.detail == "The team directory is temporarily unavailable."


def test_operator_directory_sanitizes_network_failure(monkeypatch):
    monkeypatch.setattr(main, "supabase_admin_available", True)

    async def resolve(_authorization):
        return {"id": "operator-id", "role": "Operator", "organization_id": "operator-org"}

    class DirectoryClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

        async def get(self, *args, **kwargs):
            raise main.httpx.ConnectError("private upstream detail")

    monkeypatch.setattr(main, "resolve_caller", resolve)
    monkeypatch.setattr(main.httpx, "AsyncClient", DirectoryClient)

    with pytest.raises(main.HTTPException) as error:
        asyncio.run(main.get_operator_team_directory("Bearer valid-session"))

    assert error.value.status_code == 503
    assert error.value.detail == "The team directory is temporarily unavailable."
