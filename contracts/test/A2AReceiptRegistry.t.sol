// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {A2AReceiptRegistry} from "../src/A2AReceiptRegistry.sol";

interface Vm { function prank(address) external; function expectRevert(bytes calldata) external; function expectRevert(bytes4) external; }

contract A2AReceiptRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    A2AReceiptRegistry reg;
    address seller = address(0xBEEF);
    address buyer = address(0xCAFE);
    address token = address(0x054ed45810DbBAb8B27668922D110669c9D88D0a);

    function setUp() public { reg = new A2AReceiptRegistry(); }

    function testRegisterAgent() public {
        vm.prank(seller);
        reg.registerAgent("seller", "https://example/a2a");
        (string memory n, string memory e, uint64 at,,) = reg.agents(seller);
        require(keccak256(bytes(n)) == keccak256("seller"), "name");
        require(keccak256(bytes(e)) == keccak256("https://example/a2a"), "endpoint");
        require(at > 0, "ts");
    }

    function testEmptyNameReverts() public {
        vm.expectRevert(A2AReceiptRegistry.EmptyName.selector);
        reg.registerAgent("", "x");
    }

    function testRecordSettlementBindsPayeeToSender() public {
        vm.prank(seller);
        reg.recordSettlement(bytes32("pid1"), buyer, token, 50_000, bytes32("tx"), bytes32("svc"));
        (address payer, address payee,, uint256 amt,,,) = reg.receipts(bytes32("pid1"));
        require(payer == buyer && payee == seller && amt == 50_000, "fields");
        require(reg.receiptCount() == 1, "count");
        (,,, uint64 asPayee,) = reg.agents(seller);
        (,,,, uint64 asPayer) = reg.agents(buyer);
        require(asPayee == 1 && asPayer == 1, "counters");
    }

    function testReplayReverts() public {
        vm.prank(seller);
        reg.recordSettlement(bytes32("pid1"), buyer, token, 1, bytes32("tx"), bytes32("svc"));
        vm.expectRevert(abi.encodeWithSelector(A2AReceiptRegistry.AlreadyRecorded.selector, bytes32("pid1")));
        vm.prank(seller);
        reg.recordSettlement(bytes32("pid1"), buyer, token, 1, bytes32("tx"), bytes32("svc"));
    }

    function testZeroValuesRevert() public {
        vm.expectRevert(A2AReceiptRegistry.ZeroValue.selector);
        reg.recordSettlement(bytes32(0), buyer, token, 1, bytes32("tx"), bytes32("svc"));
        vm.expectRevert(A2AReceiptRegistry.ZeroValue.selector);
        reg.recordSettlement(bytes32("p"), buyer, token, 0, bytes32("tx"), bytes32("svc"));
        vm.expectRevert(A2AReceiptRegistry.ZeroValue.selector);
        reg.recordSettlement(bytes32("p"), address(0), token, 1, bytes32("tx"), bytes32("svc"));
    }
}
