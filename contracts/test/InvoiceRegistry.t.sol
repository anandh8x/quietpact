// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {InvoiceRegistry} from "../src/InvoiceRegistry.sol";

interface Vm {
    function assume(bool condition) external;
    function expectPartialRevert(bytes4 selector) external;
    function prank(address sender) external;
}

contract InvoiceRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    InvoiceRegistry private registry;

    address private constant PAYER = address(0x1001);
    address private constant PAYEE = address(0x2002);
    bytes32 private constant INVOICE_ID = keccak256("invoice-001");
    bytes32 private constant COMMITMENT = keccak256("encrypted-invoice-commitment");
    bytes32 private constant CIPHERTEXT_HASH = keccak256("ciphertext");
    bytes32 private constant AUDITOR_KEY_ID = keccak256("auditor-key");

    function setUp() external {
        registry = new InvoiceRegistry();
    }

    function testInvoicePartyRegistersCommitmentWithoutAmount() external {
        vm.prank(PAYEE);
        registry.createInvoice(
            INVOICE_ID, PAYER, PAYEE, COMMITMENT, CIPHERTEXT_HASH, AUDITOR_KEY_ID
        );

        InvoiceRegistry.InvoiceView memory invoice = registry.getInvoice(INVOICE_ID);

        require(invoice.payer == PAYER, "wrong payer");
        require(invoice.payee == PAYEE, "wrong payee");
        require(invoice.commitment == COMMITMENT, "wrong commitment");
        require(invoice.ciphertextHash == CIPHERTEXT_HASH, "wrong ciphertext hash");
        require(invoice.auditorKeyId == AUDITOR_KEY_ID, "wrong auditor key");
        require(invoice.state == InvoiceRegistry.InvoiceState.Registered, "wrong state");
        require(invoice.publicPaymentReference == bytes32(0), "unexpected payment reference");
    }

    function testInvoiceMovesThroughPublicPaymentReferenceLifecycle() external {
        _createInvoice();

        vm.prank(PAYER);
        registry.approveInvoice(INVOICE_ID);
        require(
            registry.getInvoice(INVOICE_ID).state == InvoiceRegistry.InvoiceState.Approved,
            "invoice not approved"
        );

        bytes32 paymentReference = keccak256("public-arc-transaction");
        vm.prank(PAYER);
        registry.attachPublicPayment(INVOICE_ID, paymentReference);
        InvoiceRegistry.InvoiceView memory referenced = registry.getInvoice(INVOICE_ID);
        require(
            referenced.state == InvoiceRegistry.InvoiceState.PaymentReferenced,
            "payment not referenced"
        );
        require(referenced.publicPaymentReference == paymentReference, "wrong payment reference");

        vm.prank(PAYEE);
        registry.completeInvoice(INVOICE_ID);
        require(
            registry.getInvoice(INVOICE_ID).state == InvoiceRegistry.InvoiceState.Complete,
            "workflow not complete"
        );
    }

    function testRejectsUnauthorizedAndRepeatedInvoiceActions() external {
        _createInvoice();

        vm.prank(PAYEE);
        vm.expectPartialRevert(InvoiceRegistry.Unauthorized.selector);
        registry.approveInvoice(INVOICE_ID);

        vm.prank(PAYER);
        registry.approveInvoice(INVOICE_ID);

        vm.prank(PAYER);
        vm.expectPartialRevert(InvoiceRegistry.InvalidTransition.selector);
        registry.approveInvoice(INVOICE_ID);

        vm.prank(PAYEE);
        vm.expectPartialRevert(InvoiceRegistry.InvoiceAlreadyExists.selector);
        registry.createInvoice(
            INVOICE_ID, PAYER, PAYEE, COMMITMENT, CIPHERTEXT_HASH, AUDITOR_KEY_ID
        );
    }

    function testPartiesCanDisputeOrCancelWithoutClaimingSettlement() external {
        _createInvoice();

        vm.prank(PAYER);
        registry.approveInvoice(INVOICE_ID);
        vm.prank(PAYEE);
        registry.disputeInvoice(INVOICE_ID);
        require(
            registry.getInvoice(INVOICE_ID).state == InvoiceRegistry.InvoiceState.Disputed,
            "invoice not disputed"
        );

        bytes32 cancelledId = keccak256("invoice-cancelled");
        vm.prank(PAYEE);
        registry.createInvoice(
            cancelledId, PAYER, PAYEE, keccak256("cancelled"), CIPHERTEXT_HASH, AUDITOR_KEY_ID
        );
        vm.prank(PAYER);
        registry.cancelInvoice(cancelledId);
        require(
            registry.getInvoice(cancelledId).state == InvoiceRegistry.InvoiceState.Cancelled,
            "invoice not cancelled"
        );

        vm.prank(address(0x9999));
        vm.expectPartialRevert(InvoiceRegistry.Unauthorized.selector);
        registry.disputeInvoice(cancelledId);
    }

    function testFuzzNonPartiesCannotRegisterInvoices(address actor) external {
        vm.assume(actor != PAYER && actor != PAYEE);

        vm.prank(actor);
        vm.expectPartialRevert(InvoiceRegistry.Unauthorized.selector);
        registry.createInvoice(
            INVOICE_ID, PAYER, PAYEE, COMMITMENT, CIPHERTEXT_HASH, AUDITOR_KEY_ID
        );
    }

    function _createInvoice() private {
        vm.prank(PAYEE);
        registry.createInvoice(
            INVOICE_ID, PAYER, PAYEE, COMMITMENT, CIPHERTEXT_HASH, AUDITOR_KEY_ID
        );
    }
}
