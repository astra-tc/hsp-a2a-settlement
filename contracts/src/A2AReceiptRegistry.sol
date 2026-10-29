// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title A2AReceiptRegistry
/// @notice On-chain directory of paying/paid agents plus an append-only log of
///         HSP-settled agent-to-agent payments on HashKey Chain.
/// @dev HSP is zero-custody: the payer agent moves USDC with a plain ERC-20
///      transfer and the HSP Coordinator attests it. This contract never holds
///      funds. The seller agent (payee) anchors each settled HSP payment once,
///      binding the HSP paymentId to the transfer tx and the service delivered.
contract A2AReceiptRegistry {
    struct Agent {
        string name;
        string endpoint; // HTTP endpoint that speaks the 402 + HSP flow
        uint64 registeredAt;
        uint64 receiptsAsPayee;
        uint64 receiptsAsPayer;
    }

    struct Receipt {
        address payer;
        address payee;
        address token;
        uint256 amount;
        bytes32 transferTx;
        bytes32 serviceHash;
        uint64 recordedAt;
    }

    mapping(address => Agent) public agents;
    mapping(bytes32 => Receipt) public receipts; // HSP paymentId => receipt
    uint256 public receiptCount;

    event AgentRegistered(address indexed agent, string name, string endpoint);
    event SettlementRecorded(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        bytes32 transferTx,
        bytes32 serviceHash
    );

    error AlreadyRecorded(bytes32 paymentId);
    error ZeroValue();
    error EmptyName();

    function registerAgent(string calldata name, string calldata endpoint) external {
        if (bytes(name).length == 0) revert EmptyName();
        Agent storage a = agents[msg.sender];
        a.name = name;
        a.endpoint = endpoint;
        if (a.registeredAt == 0) a.registeredAt = uint64(block.timestamp);
        emit AgentRegistered(msg.sender, name, endpoint);
    }

    /// @notice Called by the payee agent after HSP marks the payment settled.
    /// @dev msg.sender is the payee, so an agent can only anchor receipts paid to itself.
    function recordSettlement(
        bytes32 paymentId,
        address payer,
        address token,
        uint256 amount,
        bytes32 transferTx,
        bytes32 serviceHash
    ) external {
        if (paymentId == bytes32(0) || amount == 0 || payer == address(0)) revert ZeroValue();
        if (receipts[paymentId].recordedAt != 0) revert AlreadyRecorded(paymentId);
        receipts[paymentId] = Receipt(payer, msg.sender, token, amount, transferTx, serviceHash, uint64(block.timestamp));
        unchecked {
            receiptCount++;
            agents[msg.sender].receiptsAsPayee++;
            agents[payer].receiptsAsPayer++;
        }
        emit SettlementRecorded(paymentId, payer, msg.sender, token, amount, transferTx, serviceHash);
    }
}
