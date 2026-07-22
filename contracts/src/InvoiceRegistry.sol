// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

contract InvoiceRegistry {
    enum InvoiceState {
        None,
        Registered,
        Approved,
        PaymentReferenced,
        Complete,
        Disputed,
        Cancelled
    }

    struct InvoiceView {
        address payer;
        address payee;
        bytes32 commitment;
        bytes32 ciphertextHash;
        bytes32 auditorKeyId;
        bytes32 publicPaymentReference;
        uint64 createdAt;
        InvoiceState state;
    }

    error InvoiceAlreadyExists(bytes32 invoiceId);
    error InvoiceNotFound(bytes32 invoiceId);
    error ActionNotAllowed(bytes32 invoiceId, InvoiceState current);
    error InvalidInvoiceData();
    error InvalidPaymentReference();
    error InvalidTransition(bytes32 invoiceId, InvoiceState current, InvoiceState required);
    error Unauthorized(address actor);

    event InvoiceCreated(
        bytes32 indexed invoiceId,
        address indexed payer,
        address indexed payee,
        bytes32 commitment,
        bytes32 ciphertextHash,
        bytes32 auditorKeyId
    );
    event InvoiceStateChanged(bytes32 indexed invoiceId, InvoiceState state);
    event PublicPaymentReferenced(bytes32 indexed invoiceId, bytes32 indexed transactionReference);

    mapping(bytes32 invoiceId => InvoiceView invoice) private invoices;

    function createInvoice(
        bytes32 invoiceId,
        address payer,
        address payee,
        bytes32 commitment,
        bytes32 ciphertextHash,
        bytes32 auditorKeyId
    ) external {
        if (msg.sender != payer && msg.sender != payee) {
            revert Unauthorized(msg.sender);
        }
        if (
            invoiceId == bytes32(0) || payer == address(0) || payee == address(0) || payer == payee
                || commitment == bytes32(0) || ciphertextHash == bytes32(0)
        ) revert InvalidInvoiceData();
        if (invoices[invoiceId].state != InvoiceState.None) revert InvoiceAlreadyExists(invoiceId);

        invoices[invoiceId] = InvoiceView({
            payer: payer,
            payee: payee,
            commitment: commitment,
            ciphertextHash: ciphertextHash,
            auditorKeyId: auditorKeyId,
            publicPaymentReference: bytes32(0),
            createdAt: uint64(block.timestamp),
            state: InvoiceState.Registered
        });

        emit InvoiceCreated(invoiceId, payer, payee, commitment, ciphertextHash, auditorKeyId);
    }

    function getInvoice(bytes32 invoiceId) external view returns (InvoiceView memory invoice) {
        invoice = invoices[invoiceId];
        if (invoice.state == InvoiceState.None) revert InvoiceNotFound(invoiceId);
    }

    function approveInvoice(bytes32 invoiceId) external {
        InvoiceView storage invoice = _requireInvoice(invoiceId);
        if (msg.sender != invoice.payer) revert Unauthorized(msg.sender);
        _requireState(invoiceId, invoice, InvoiceState.Registered);

        invoice.state = InvoiceState.Approved;
        emit InvoiceStateChanged(invoiceId, InvoiceState.Approved);
    }

    function attachPublicPayment(bytes32 invoiceId, bytes32 transactionReference) external {
        InvoiceView storage invoice = _requireInvoice(invoiceId);
        if (msg.sender != invoice.payer) revert Unauthorized(msg.sender);
        _requireState(invoiceId, invoice, InvoiceState.Approved);
        if (transactionReference == bytes32(0)) revert InvalidPaymentReference();

        invoice.publicPaymentReference = transactionReference;
        invoice.state = InvoiceState.PaymentReferenced;
        emit PublicPaymentReferenced(invoiceId, transactionReference);
        emit InvoiceStateChanged(invoiceId, InvoiceState.PaymentReferenced);
    }

    function completeInvoice(bytes32 invoiceId) external {
        InvoiceView storage invoice = _requireInvoice(invoiceId);
        if (msg.sender != invoice.payee) revert Unauthorized(msg.sender);
        _requireState(invoiceId, invoice, InvoiceState.PaymentReferenced);

        invoice.state = InvoiceState.Complete;
        emit InvoiceStateChanged(invoiceId, InvoiceState.Complete);
    }

    function disputeInvoice(bytes32 invoiceId) external {
        InvoiceView storage invoice = _requireInvoice(invoiceId);
        _requireParty(invoice);
        if (
            invoice.state != InvoiceState.Registered && invoice.state != InvoiceState.Approved
                && invoice.state != InvoiceState.PaymentReferenced
        ) revert ActionNotAllowed(invoiceId, invoice.state);

        invoice.state = InvoiceState.Disputed;
        emit InvoiceStateChanged(invoiceId, InvoiceState.Disputed);
    }

    function cancelInvoice(bytes32 invoiceId) external {
        InvoiceView storage invoice = _requireInvoice(invoiceId);
        _requireParty(invoice);
        if (invoice.state != InvoiceState.Registered && invoice.state != InvoiceState.Approved) {
            revert ActionNotAllowed(invoiceId, invoice.state);
        }

        invoice.state = InvoiceState.Cancelled;
        emit InvoiceStateChanged(invoiceId, InvoiceState.Cancelled);
    }

    function _requireInvoice(bytes32 invoiceId) private view returns (InvoiceView storage invoice) {
        invoice = invoices[invoiceId];
        if (invoice.state == InvoiceState.None) revert InvoiceNotFound(invoiceId);
    }

    function _requireState(bytes32 invoiceId, InvoiceView storage invoice, InvoiceState required)
        private
        view
    {
        if (invoice.state != required) {
            revert InvalidTransition(invoiceId, invoice.state, required);
        }
    }

    function _requireParty(InvoiceView storage invoice) private view {
        if (msg.sender != invoice.payer && msg.sender != invoice.payee) {
            revert Unauthorized(msg.sender);
        }
    }
}
