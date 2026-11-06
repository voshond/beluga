import { Center } from './NotificationCenter.js';
import s from './notifications.module.css';

const stay = (): void => undefined;

export function NotificationsView() {
  return (
    <section className={s.page} aria-label="Notifications">
      <Center close={stay} />
    </section>
  );
}
