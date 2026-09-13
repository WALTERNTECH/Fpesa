import { useApp } from '../store/app';
import { Modal } from './Modal';
import { TradeHistory } from './TradeHistory';

/** The record, reached from Positions rather than stacked under the ticket. */
export function HistoryModal(): JSX.Element {
  const { closeModal } = useApp();
  return (
    <Modal title="Positions" onClose={closeModal}>
      <TradeHistory />
    </Modal>
  );
}
