import React, { Fragment } from 'react';

import { TEditorBlock } from '../../../editor/core';
import EditorBlock, {useCurrentBlockId} from '../../../editor/EditorBlock';

import AddBlockButton from './AddBlockMenu';

export type EditorChildrenChange = {
  blockId: string;
  block: TEditorBlock;
  childrenIds: string[];
};

function generateId() {
  return `block-${Date.now()}`;
}

export type EditorChildrenIdsProps = {
  childrenIds: string[] | null | undefined;
  columnIndex?: number;
  onChange: (val: EditorChildrenChange) => void;
};
export default function EditorChildrenIds({ childrenIds, onChange, columnIndex }: EditorChildrenIdsProps) {
  const parentId = useCurrentBlockId();
  const appendBlock = (block: TEditorBlock) => {
    const blockId = generateId();
    return onChange({
      blockId,
      block,
      childrenIds: [...(childrenIds || []), blockId],
    });
  };

  const insertBlock = (block: TEditorBlock, index: number) => {
    const blockId = generateId();
    const newChildrenIds = [...(childrenIds || [])];
    newChildrenIds.splice(index, 0, blockId);
    return onChange({
      blockId,
      block,
      childrenIds: newChildrenIds,
    });
  };

  if (!childrenIds || childrenIds.length === 0) {
    return <div data-builder-parent={parentId} data-builder-column={columnIndex}><AddBlockButton placeholder onSelect={appendBlock} /></div>;
  }

  return (
    <div data-builder-parent={parentId} data-builder-column={columnIndex}>
      {childrenIds.map((childId, i) => (
        <Fragment key={childId}>
          <AddBlockButton onSelect={(block) => insertBlock(block, i)} />
          <div data-builder-index={i}><EditorBlock id={childId} /></div>
        </Fragment>
      ))}
      <AddBlockButton onSelect={appendBlock} />
    </div>
  );
}
